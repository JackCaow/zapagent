package platform

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	windowsServiceProtocolVersion = 1
	windowsServiceMaxFrame        = 1 * MiB
)

const (
	windowsServiceOpPing   = "ping"
	windowsServiceOpStart  = "start"
	windowsServiceOpStop   = "stop"
	windowsServiceOpPause  = "pause"
	windowsServiceOpResume = "resume"
	windowsServiceOpQuery  = "query"
)

type windowsServiceRequest struct {
	Version   int    `json:"version"`
	Operation string `json:"operation"`
	VMID      string `json:"vm_id,omitempty"`
	Spec      *Spec  `json:"spec,omitempty"`
}

type windowsServiceResponse struct {
	Version int    `json:"version"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	VMID    string `json:"vm_id,omitempty"`
	ID      string `json:"id,omitempty"`
	State   State  `json:"state,omitempty"`
}

func (request windowsServiceRequest) validate() error {
	if request.Version != windowsServiceProtocolVersion {
		return fmt.Errorf("unsupported Windows service protocol version %d", request.Version)
	}
	switch request.Operation {
	case windowsServiceOpPing:
		if request.VMID != "" || request.Spec != nil {
			return errors.New("ping request must not contain VM fields")
		}
	case windowsServiceOpStart:
		if request.VMID != "" || request.Spec == nil {
			return errors.New("start request requires spec and no vm_id")
		}
	case windowsServiceOpStop, windowsServiceOpPause, windowsServiceOpResume, windowsServiceOpQuery:
		if request.VMID == "" || request.Spec != nil {
			return fmt.Errorf("%s request requires vm_id and no spec", request.Operation)
		}
	default:
		return fmt.Errorf("unsupported Windows service operation %q", request.Operation)
	}
	return nil
}

func (response windowsServiceResponse) validateFor(request windowsServiceRequest) error {
	if response.Version != windowsServiceProtocolVersion {
		return fmt.Errorf("unsupported service response version %d", response.Version)
	}
	if !response.OK {
		if response.Error == "" {
			return errors.New("Windows service request failed without detail")
		}
		return errors.New(response.Error)
	}
	if response.Error != "" {
		return errors.New("successful Windows service response must not contain an error")
	}
	switch request.Operation {
	case windowsServiceOpPing:
		if response.VMID != "" || response.ID != "" || response.State != "" {
			return errors.New("ping response must not contain VM fields")
		}
	case windowsServiceOpStart:
		if request.Spec == nil || response.VMID == "" || response.ID != request.Spec.ID || response.State != StateRunning {
			return errors.New("start response has inconsistent VM identity or state")
		}
	case windowsServiceOpStop, windowsServiceOpPause, windowsServiceOpResume, windowsServiceOpQuery:
		if response.VMID != request.VMID || response.ID == "" || !validServiceVMState(response.State) {
			return fmt.Errorf("%s response has inconsistent VM identity or state", request.Operation)
		}
	default:
		return fmt.Errorf("cannot validate response for operation %q", request.Operation)
	}
	return nil
}

func validServiceVMState(state State) bool {
	switch state {
	case StateStarting, StateRunning, StatePausing, StatePaused, StateResuming, StateStopping, StateStopped, StateFailed:
		return true
	default:
		return false
	}
}

func writeWindowsServiceFrame(writer io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(payload) == 0 || len(payload) > windowsServiceMaxFrame {
		return fmt.Errorf("Windows service frame size %d is outside 1-%d bytes", len(payload), windowsServiceMaxFrame)
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	if err := writeWindowsServiceBytes(writer, header[:]); err != nil {
		return err
	}
	return writeWindowsServiceBytes(writer, payload)
}

func writeWindowsServiceBytes(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if written <= 0 || written > len(payload) {
			return io.ErrShortWrite
		}
		payload = payload[written:]
	}
	return nil
}

func readWindowsServiceFrame(reader io.Reader, value any) error {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return err
	}
	size := binary.LittleEndian.Uint32(header[:])
	if size == 0 || size > windowsServiceMaxFrame {
		return fmt.Errorf("Windows service frame size %d is outside 1-%d bytes", size, windowsServiceMaxFrame)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("Windows service frame contains trailing JSON")
		}
		return err
	}
	return nil
}
