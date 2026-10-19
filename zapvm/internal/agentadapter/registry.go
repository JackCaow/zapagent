package agentadapter

import (
	"errors"
	"fmt"
	"sort"
)

type Registry struct {
	protocols map[string]Protocol
}

func NewRegistry(protocols ...Protocol) (*Registry, error) {
	registry := &Registry{protocols: make(map[string]Protocol, len(protocols))}
	for _, protocol := range protocols {
		if protocol == nil || protocol.Name() == "" {
			return nil, errors.New("Agent adapter protocol must have a name")
		}
		if _, exists := registry.protocols[protocol.Name()]; exists {
			return nil, fmt.Errorf("Agent adapter protocol %q is already registered", protocol.Name())
		}
		registry.protocols[protocol.Name()] = protocol
	}
	return registry, nil
}

func (registry *Registry) Names() []string {
	if registry == nil {
		return nil
	}
	names := make([]string, 0, len(registry.protocols))
	for name := range registry.protocols {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (registry *Registry) Decode(data []byte) (Protocol, Request, error) {
	if registry == nil {
		return nil, Request{}, errors.New("Agent adapter registry is unavailable")
	}
	matches := make([]Protocol, 0, 1)
	for _, protocol := range registry.protocols {
		if protocol.Match(data) {
			matches = append(matches, protocol)
		}
	}
	if len(matches) == 0 {
		return nil, Request{}, errors.New("input does not match a registered Agent adapter protocol")
	}
	if len(matches) != 1 {
		return nil, Request{}, errors.New("input ambiguously matches multiple Agent adapter protocols")
	}
	request, err := matches[0].Decode(data)
	if err != nil {
		return nil, Request{}, fmt.Errorf("decode %s request: %w", matches[0].Name(), err)
	}
	request.Protocol = matches[0].Name()
	return matches[0], request, nil
}
