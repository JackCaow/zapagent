package controlpostgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
)

type Primary struct {
	migrator *Migrator
}

func NewPrimary(migrator *Migrator) (*Primary, error) {
	if migrator == nil || migrator.pool == nil {
		return nil, errors.New("PostgreSQL migrator is not open")
	}
	return &Primary{migrator: migrator}, nil
}

func (primary *Primary) Load(ctx context.Context) (cloudplane.OfflineSnapshot, bool, error) {
	if primary == nil || primary.migrator == nil {
		return cloudplane.OfflineSnapshot{}, false, errors.New("PostgreSQL primary State store is not open")
	}
	return primary.migrator.LoadPrimarySnapshot(ctx)
}

func (primary *Primary) Commit(ctx context.Context, snapshot cloudplane.OfflineSnapshot) error {
	if primary == nil || primary.migrator == nil {
		return errors.New("PostgreSQL primary State store is not open")
	}
	_, err := primary.migrator.CommitPrimarySnapshot(ctx, snapshot)
	return err
}

// LoadPrimarySnapshot returns the exact snapshot committed by
// CommitPrimarySnapshot only after verifying its digest, the normalized
// database projection, and the file-mirror metadata in one read transaction.
func (migrator *Migrator) LoadPrimarySnapshot(ctx context.Context) (cloudplane.OfflineSnapshot, bool, error) {
	if migrator == nil || migrator.pool == nil || ctx == nil {
		return cloudplane.OfflineSnapshot{}, false, errors.New("PostgreSQL migrator is not open")
	}
	connection, err := migrator.pool.Acquire(ctx)
	if err != nil {
		return cloudplane.OfflineSnapshot{}, false, errors.New("acquire PostgreSQL primary state connection")
	}
	defer connection.Release()
	transaction, err := connection.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable, AccessMode: pgx.ReadOnly})
	if err != nil {
		return cloudplane.OfflineSnapshot{}, false, errors.New("begin PostgreSQL primary state read")
	}
	defer rollbackBounded(transaction)
	if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1), pg_advisory_xact_lock_shared($2)`, advisoryLockID, snapshotImportLockID); err != nil {
		return cloudplane.OfflineSnapshot{}, false, errors.New("acquire PostgreSQL primary state lock")
	}
	if err := migrator.requireCurrentSchema(ctx, transaction); err != nil {
		return cloudplane.OfflineSnapshot{}, false, err
	}
	if err := enableOwnerBypass(ctx, transaction); err != nil {
		return cloudplane.OfflineSnapshot{}, false, err
	}
	var generation int64
	var raw, sourceDigest, recordedDatabaseDigest []byte
	var committedAt time.Time
	err = transaction.QueryRow(ctx, `SELECT generation, snapshot, source_sha256, database_sha256, committed_at FROM zapvm.primary_state WHERE singleton`).Scan(
		&generation, &raw, &sourceDigest, &recordedDatabaseDigest, &committedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := transaction.Commit(ctx); err != nil {
			return cloudplane.OfflineSnapshot{}, false, errors.New("commit PostgreSQL empty primary state read")
		}
		return cloudplane.OfflineSnapshot{}, false, nil
	}
	if err != nil {
		return cloudplane.OfflineSnapshot{}, false, databaseFailure("read PostgreSQL primary Control state", err)
	}
	if generation < 1 || len(raw) < 2 || len(raw) > maxPrimarySnapshotSize || len(sourceDigest) != sha256.Size || len(recordedDatabaseDigest) != sha256.Size || committedAt.IsZero() {
		return cloudplane.OfflineSnapshot{}, false, errors.New("PostgreSQL primary Control state metadata is invalid")
	}
	var snapshot cloudplane.OfflineSnapshot
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&snapshot); err != nil {
		return cloudplane.OfflineSnapshot{}, false, errors.New("decode PostgreSQL primary Control state")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return cloudplane.OfflineSnapshot{}, false, errors.New("PostgreSQL primary Control state contains trailing JSON")
	}
	canonical, err := snapshot.CanonicalJSON()
	if err != nil || !bytes.Equal(canonical, raw) {
		return cloudplane.OfflineSnapshot{}, false, errors.New("PostgreSQL primary Control state is not canonical")
	}
	digest := sha256.Sum256(canonical)
	if !bytes.Equal(digest[:], sourceDigest) {
		return cloudplane.OfflineSnapshot{}, false, errors.New("PostgreSQL primary Control state digest is invalid")
	}
	metadata, exists, err := readMirrorMetadata(ctx, transaction)
	if err != nil {
		return cloudplane.OfflineSnapshot{}, false, err
	}
	if !exists || !bytes.Equal(metadata.sourceDigest, sourceDigest) || !bytes.Equal(metadata.databaseDigest, recordedDatabaseDigest) {
		return cloudplane.OfflineSnapshot{}, false, errors.New("PostgreSQL primary Control state metadata differs from its projection")
	}
	databaseDigest, rowCounts, err := databaseStateDigest(ctx, transaction)
	if err != nil {
		return cloudplane.OfflineSnapshot{}, false, err
	}
	if !bytes.Equal(databaseDigest, recordedDatabaseDigest) || !equalRowCounts(rowCounts, metadata.rowCounts) {
		return cloudplane.OfflineSnapshot{}, false, errors.New("PostgreSQL primary Control state projection drift detected")
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.OfflineSnapshot{}, false, errors.New("commit PostgreSQL primary state read")
	}
	return snapshot, true, nil
}
