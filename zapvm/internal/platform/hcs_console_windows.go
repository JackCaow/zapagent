//go:build windows

package platform

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"

	winio "github.com/Microsoft/go-winio"
)

const (
	hcsConsolePipeSDDL   = "D:P(A;;FA;;;SY)(A;;FA;;;BA)"
	hcsConsoleMaxLogSize = int64(8 * 1024 * 1024)
)

type hcsConsoleCapture struct {
	pipePath  string
	logPath   string
	listener  net.Listener
	done      chan struct{}
	closeOnce sync.Once

	mu         sync.Mutex
	connection net.Conn
	closing    bool
	err        error
}

func newHCSConsoleCapture(vmID string) (*hcsConsoleCapture, error) {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		return nil, errors.New("ProgramData is not set")
	}
	directory := filepath.Join(programData, "zapVM")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return nil, fmt.Errorf("create HCS console directory: %w", err)
	}
	if err := secureWindowsServiceDirectory(directory); err != nil {
		return nil, fmt.Errorf("secure HCS console directory: %w", err)
	}
	logPath := filepath.Join(directory, "console-"+vmID+".log")
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open HCS console log: %w", err)
	}
	if err := secureWindowsServiceFile(logPath); err != nil {
		_ = file.Close()
		_ = os.Remove(logPath)
		return nil, fmt.Errorf("secure HCS console log: %w", err)
	}
	pipePath := `\\.\pipe\zapvm-console-` + vmID
	listener, err := winio.ListenPipe(pipePath, &winio.PipeConfig{
		SecurityDescriptor: hcsConsolePipeSDDL,
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	})
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("listen for HCS serial console: %w", err)
	}
	capture := &hcsConsoleCapture{
		pipePath: pipePath,
		logPath:  logPath,
		listener: listener,
		done:     make(chan struct{}),
	}
	go capture.run(file)
	return capture, nil
}

func (c *hcsConsoleCapture) run(file *os.File) {
	defer close(c.done)
	connection, err := c.listener.Accept()
	if err != nil {
		c.mu.Lock()
		if !c.closing {
			c.err = errors.Join(c.err, fmt.Errorf("accept HCS serial console: %w", err))
		}
		c.mu.Unlock()
	} else {
		c.mu.Lock()
		closing := c.closing
		if !closing {
			c.connection = connection
		}
		c.mu.Unlock()
		if closing {
			_ = connection.Close()
		} else {
			_, copyErr := io.Copy(&cappedConsoleWriter{writer: file, remaining: hcsConsoleMaxLogSize}, connection)
			_ = connection.Close()
			c.mu.Lock()
			c.connection = nil
			if copyErr != nil && !c.closing {
				c.err = errors.Join(c.err, fmt.Errorf("capture HCS serial console: %w", copyErr))
			}
			c.mu.Unlock()
		}
	}
	if err := file.Sync(); err != nil {
		c.mu.Lock()
		c.err = errors.Join(c.err, fmt.Errorf("sync HCS console log: %w", err))
		c.mu.Unlock()
	}
	if err := file.Close(); err != nil {
		c.mu.Lock()
		c.err = errors.Join(c.err, fmt.Errorf("close HCS console log: %w", err))
		c.mu.Unlock()
	}
}

func (c *hcsConsoleCapture) Close() error {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closing = true
		connection := c.connection
		c.mu.Unlock()
		_ = c.listener.Close()
		if connection != nil {
			_ = connection.Close()
		}
		<-c.done
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

type cappedConsoleWriter struct {
	writer    io.Writer
	remaining int64
}

func (w *cappedConsoleWriter) Write(data []byte) (int, error) {
	originalLength := len(data)
	if w.remaining <= 0 || originalLength == 0 {
		return originalLength, nil
	}
	writeLength := int64(originalLength)
	if writeLength > w.remaining {
		writeLength = w.remaining
	}
	written, err := w.writer.Write(data[:writeLength])
	w.remaining -= int64(written)
	if err != nil {
		return written, err
	}
	if int64(written) != writeLength {
		return written, io.ErrShortWrite
	}
	return originalLength, nil
}
