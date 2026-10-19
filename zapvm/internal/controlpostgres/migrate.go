package controlpostgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	advisoryLockID   int64 = 0x5a4150564d444201
	connectTimeout         = 10 * time.Second
	maxMigrationSize       = 1 << 20
)

var (
	//go:embed migrations/*.sql
	migrationFiles embed.FS
	migrationName  = regexp.MustCompile(`^([0-9]{4})_([a-z][a-z0-9_]*)\.sql$`)
)

const bootstrapSQL = `
CREATE SCHEMA IF NOT EXISTS zapvm;
DO $zapvm_bootstrap$
BEGIN
    IF NOT pg_has_role(current_user, (SELECT nspowner FROM pg_namespace WHERE oid = 'zapvm'::regnamespace), 'USAGE') THEN
        RAISE EXCEPTION 'current role must own the zapvm schema or inherit from its owner';
    END IF;
END;
$zapvm_bootstrap$;
CREATE TABLE IF NOT EXISTS zapvm.schema_migrations (
    version bigint PRIMARY KEY CHECK (version > 0),
    name text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]{0,127}$'),
    checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);`

type Migration struct {
	Version  int64
	Name     string
	SQL      string
	Checksum [sha256.Size]byte
}

type AppliedMigration struct {
	Version   int64     `json:"version"`
	Name      string    `json:"name"`
	Checksum  string    `json:"checksum"`
	AppliedAt time.Time `json:"applied_at"`
}

type Status struct {
	Current int64              `json:"current"`
	Pending int                `json:"pending"`
	Applied []AppliedMigration `json:"applied"`
}

type OpenOptions struct {
	AllowInsecureLocalhost bool
}

type Migrator struct {
	pool       *pgxpool.Pool
	migrations []Migration
}

func Open(ctx context.Context, dsn string, options OpenOptions) (*Migrator, error) {
	if ctx == nil {
		return nil, errors.New("PostgreSQL context is required")
	}
	if err := validateDSN(dsn); err != nil {
		return nil, err
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("PostgreSQL DSN is invalid")
	}
	if config.ConnConfig.TLSConfig == nil && (!options.AllowInsecureLocalhost || !localHost(config.ConnConfig.Host)) {
		return nil, errors.New("PostgreSQL TLS is required outside explicit localhost development")
	}
	config.MaxConns = 4
	config.MinConns = 0
	config.MaxConnLifetime = 30 * time.Minute
	config.MaxConnIdleTime = 5 * time.Minute
	config.HealthCheckPeriod = 30 * time.Second
	config.ConnConfig.ConnectTimeout = connectTimeout
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = make(map[string]string)
	}
	config.ConnConfig.RuntimeParams["application_name"] = "zapvm-control-db"
	migrations, err := loadMigrations()
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, errors.New("open PostgreSQL pool")
	}
	pingContext, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	if err := pool.Ping(pingContext); err != nil {
		pool.Close()
		return nil, errors.New("connect to PostgreSQL")
	}
	return &Migrator{pool: pool, migrations: migrations}, nil
}

func (migrator *Migrator) Close() {
	if migrator != nil && migrator.pool != nil {
		migrator.pool.Close()
	}
}

func (migrator *Migrator) Apply(ctx context.Context) (Status, error) {
	if migrator == nil || migrator.pool == nil || ctx == nil {
		return Status{}, errors.New("PostgreSQL migrator is not open")
	}
	connection, err := migrator.pool.Acquire(ctx)
	if err != nil {
		return Status{}, errors.New("acquire PostgreSQL migration connection")
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock($1)`, advisoryLockID); err != nil {
		return Status{}, errors.New("acquire PostgreSQL migration lock")
	}
	defer func() {
		unlockContext, cancel := context.WithTimeout(context.Background(), connectTimeout)
		defer cancel()
		_, _ = connection.Exec(unlockContext, `SELECT pg_advisory_unlock($1)`, advisoryLockID)
	}()
	if _, err := connection.Exec(ctx, bootstrapSQL); err != nil {
		return Status{}, fmt.Errorf("bootstrap PostgreSQL migration ledger: %w", err)
	}
	for _, migration := range migrator.migrations {
		if err := applyMigration(ctx, connection, migration); err != nil {
			return Status{}, err
		}
	}
	return migrator.status(ctx, connection)
}

func (migrator *Migrator) Status(ctx context.Context) (Status, error) {
	if migrator == nil || migrator.pool == nil || ctx == nil {
		return Status{}, errors.New("PostgreSQL migrator is not open")
	}
	connection, err := migrator.pool.Acquire(ctx)
	if err != nil {
		return Status{}, errors.New("acquire PostgreSQL status connection")
	}
	defer connection.Release()
	return migrator.status(ctx, connection)
}

func applyMigration(ctx context.Context, connection *pgxpool.Conn, migration Migration) error {
	transaction, err := connection.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return fmt.Errorf("begin PostgreSQL migration %d: %w", migration.Version, err)
	}
	defer func() {
		rollbackContext, cancel := context.WithTimeout(context.Background(), connectTimeout)
		defer cancel()
		_ = transaction.Rollback(rollbackContext)
	}()
	var existingName string
	var existingChecksum []byte
	err = transaction.QueryRow(ctx, `SELECT name, checksum FROM zapvm.schema_migrations WHERE version = $1`, migration.Version).Scan(&existingName, &existingChecksum)
	switch {
	case err == nil:
		if existingName != migration.Name || !bytes.Equal(existingChecksum, migration.Checksum[:]) {
			return fmt.Errorf("PostgreSQL migration %d checksum or name differs from the binary", migration.Version)
		}
		return transaction.Commit(ctx)
	case !errors.Is(err, pgx.ErrNoRows):
		return fmt.Errorf("inspect PostgreSQL migration %d: %w", migration.Version, err)
	}
	if _, err := transaction.Exec(ctx, migration.SQL); err != nil {
		return fmt.Errorf("apply PostgreSQL migration %d %s: %w", migration.Version, migration.Name, err)
	}
	if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, migration.Version, migration.Name, migration.Checksum[:]); err != nil {
		return fmt.Errorf("record PostgreSQL migration %d: %w", migration.Version, err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit PostgreSQL migration %d: %w", migration.Version, err)
	}
	return nil
}

func (migrator *Migrator) status(ctx context.Context, connection *pgxpool.Conn) (Status, error) {
	var ledgerExists bool
	if err := connection.QueryRow(ctx, `SELECT to_regclass('zapvm.schema_migrations') IS NOT NULL`).Scan(&ledgerExists); err != nil {
		return Status{}, errors.New("inspect PostgreSQL migration ledger")
	}
	if !ledgerExists {
		return Status{Pending: len(migrator.migrations)}, nil
	}
	rows, err := connection.Query(ctx, `SELECT version, name, encode(checksum, 'hex'), applied_at FROM zapvm.schema_migrations ORDER BY version`)
	if err != nil {
		return Status{}, errors.New("list PostgreSQL migrations")
	}
	defer rows.Close()
	result := Status{Applied: make([]AppliedMigration, 0, len(migrator.migrations))}
	for rows.Next() {
		var applied AppliedMigration
		if err := rows.Scan(&applied.Version, &applied.Name, &applied.Checksum, &applied.AppliedAt); err != nil {
			return Status{}, errors.New("decode PostgreSQL migration")
		}
		result.Applied = append(result.Applied, applied)
		result.Current = applied.Version
	}
	if err := rows.Err(); err != nil {
		return Status{}, errors.New("read PostgreSQL migrations")
	}
	if len(result.Applied) > len(migrator.migrations) {
		return Status{}, errors.New("PostgreSQL schema is newer than this binary")
	}
	for index, applied := range result.Applied {
		expected := migrator.migrations[index]
		if applied.Version != expected.Version || applied.Name != expected.Name || applied.Checksum != fmt.Sprintf("%x", expected.Checksum) {
			return Status{}, fmt.Errorf("PostgreSQL migration ledger diverges at version %d", applied.Version)
		}
	}
	result.Pending = len(migrator.migrations) - len(result.Applied)
	return result, nil
}

func loadMigrations() ([]Migration, error) {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return nil, err
	}
	result := make([]Migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			return nil, errors.New("PostgreSQL migration directory contains a nested directory")
		}
		matches := migrationName.FindStringSubmatch(entry.Name())
		if len(matches) != 3 {
			return nil, fmt.Errorf("PostgreSQL migration name %q is invalid", entry.Name())
		}
		version, err := strconv.ParseInt(matches[1], 10, 64)
		if err != nil || version < 1 {
			return nil, fmt.Errorf("PostgreSQL migration version %q is invalid", matches[1])
		}
		data, err := migrationFiles.ReadFile(path.Join("migrations", entry.Name()))
		if err != nil || len(data) == 0 || len(data) > maxMigrationSize || bytes.IndexByte(data, 0) >= 0 {
			return nil, fmt.Errorf("PostgreSQL migration %q is empty, oversized, or contains NUL", entry.Name())
		}
		result = append(result, Migration{Version: version, Name: matches[2], SQL: string(data), Checksum: sha256.Sum256(data)})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Version < result[right].Version })
	for index, migration := range result {
		if migration.Version != int64(index+1) {
			return nil, errors.New("PostgreSQL migration versions must be contiguous from 1")
		}
	}
	if len(result) == 0 {
		return nil, errors.New("PostgreSQL migration set is empty")
	}
	return result, nil
}

func validateDSN(dsn string) error {
	if dsn == "" || len(dsn) > 8192 || strings.IndexByte(dsn, 0) >= 0 {
		return errors.New("PostgreSQL DSN is empty or invalid")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" || parsed.Fragment != "" {
		return errors.New("PostgreSQL DSN must be a postgres or postgresql URL")
	}
	return nil
}

func localHost(host string) bool {
	value := strings.TrimSpace(strings.Trim(host, "[]"))
	if strings.EqualFold(value, "localhost") {
		return true
	}
	address := net.ParseIP(value)
	return address != nil && address.IsLoopback()
}
