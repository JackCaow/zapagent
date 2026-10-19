//go:build windows

package localipc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strings"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

type authenticatedPipeListener struct {
	net.Listener
	userSID string
}

func listen(endpoint string) (net.Listener, error) {
	if err := validatePipeName(endpoint); err != nil {
		return nil, err
	}
	sid, err := currentUserSID()
	if err != nil {
		return nil, err
	}
	// Protected DACL: current user and LocalSystem only. Administrators are not
	// implicitly granted access to an ordinary user's daemon endpoint.
	sddl := fmt.Sprintf("D:P(A;;GA;;;%s)(A;;GA;;;SY)", sid)
	listener, err := winio.ListenPipe(endpoint, &winio.PipeConfig{
		SecurityDescriptor: sddl,
		MessageMode:        false,
		InputBufferSize:    64 << 10,
		OutputBufferSize:   64 << 10,
	})
	if err != nil {
		return nil, err
	}
	return &authenticatedPipeListener{Listener: listener, userSID: sid}, nil
}

func listenRecovering(endpoint string) (net.Listener, error) {
	return listen(endpoint)
}

func dial(ctx context.Context, endpoint string) (net.Conn, error) {
	if err := validatePipeName(endpoint); err != nil {
		return nil, err
	}
	connection, err := winio.DialPipeContext(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	sid, err := currentUserSID()
	if err == nil {
		err = validatePipePeer(connection, sid, true)
	}
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	return connection, nil
}

func defaultEndpoint() (string, error) {
	sid, err := currentUserSID()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(sid))
	return `\\.\pipe\zapvm-` + hex.EncodeToString(digest[:8]), nil
}

func (listener *authenticatedPipeListener) Accept() (net.Conn, error) {
	for {
		connection, err := listener.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if err := validatePipePeer(connection, listener.userSID, false); err != nil {
			_ = connection.Close()
			continue
		}
		return connection, nil
	}
}

func validatePipePeer(connection net.Conn, expectedSID string, serverPeer bool) error {
	handleProvider, ok := connection.(interface{ Fd() uintptr })
	if !ok {
		return errors.New("named-pipe connection does not expose a Windows handle")
	}
	pipe := windows.Handle(handleProvider.Fd())
	var processID uint32
	var err error
	if serverPeer {
		err = windows.GetNamedPipeServerProcessId(pipe, &processID)
	} else {
		err = windows.GetNamedPipeClientProcessId(pipe, &processID)
	}
	if err != nil || processID == 0 {
		return errors.New("named-pipe peer process is unavailable")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, processID)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	if user == nil || user.User.Sid == nil || !strings.EqualFold(user.User.Sid.String(), expectedSID) {
		return errors.New("named-pipe peer SID does not match the current user")
	}
	return nil
}

func validatePipeName(endpoint string) error {
	if len(endpoint) < len(`\\.\pipe\`)+1 || len(endpoint) > 256 || strings.IndexByte(endpoint, 0) >= 0 || !strings.HasPrefix(strings.ToLower(endpoint), `\\.\pipe\zapvm-`) {
		return errors.New(`local IPC pipe must use the \\.\pipe\zapvm-* namespace`)
	}
	return nil
}

func currentUserSID() (string, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	if user == nil || user.User.Sid == nil {
		return "", errors.New("current Windows token has no user SID")
	}
	return user.User.Sid.String(), nil
}
