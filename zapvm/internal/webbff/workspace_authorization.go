package webbff

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

type workspaceMemberResponse struct {
	Role   string `json:"role"`
	Status string `json:"status"`
}

type computerRuntimeResponse struct {
	ComputerID         string `json:"computer_id"`
	AgentID            string `json:"agent_id"`
	DisplayName        string `json:"display_name"`
	RuntimeRef         string `json:"runtime_ref"`
	ProviderBaseURL    string `json:"provider_base_url"`
	Model              string `json:"model"`
	ModelCredentialID  string `json:"model_credential_id"`
	SearchCredentialID string `json:"search_credential_id,omitempty"`
	MaxTurns           uint16 `json:"max_turns,omitempty"`
	TimeoutSeconds     uint32 `json:"timeout_seconds,omitempty"`
}

func (server *Server) resolveWorkspaceRole(ctx context.Context, project ProjectRuntime, userID, userName string, bootstrap bool) (string, error) {
	requestContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	endpoint := *project.ControlURL
	endpoint.Path = "/v1/workspace/me"
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-ZapVM-User-ID", userID)
	request.Header.Set("X-ZapVM-User-Name", userName)
	if bootstrap {
		request.Header.Set("X-ZapVM-Bootstrap-Owner", "owner")
	}
	response, err := (&http.Client{Transport: project.Transport, Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errors.New("Workspace membership was rejected")
	}
	var member workspaceMemberResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, 8<<10))
	if decoder.Decode(&member) != nil || member.Status != "active" || !validSessionRole(member.Role) {
		return "", errors.New("Workspace membership response is invalid")
	}
	return member.Role, nil
}

func (server *Server) resolveComputerRuntime(ctx context.Context, project ProjectRuntime, userID, userName, computerID string) (RuntimeProfile, bool, error) {
	requestContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	endpoint := *project.ControlURL
	endpoint.Path = "/v1/workspace/runtime"
	query := endpoint.Query()
	query.Set("computer_id", computerID)
	endpoint.RawQuery = query.Encode()
	endpoint.Fragment = ""
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return RuntimeProfile{}, false, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-ZapVM-User-ID", userID)
	request.Header.Set("X-ZapVM-User-Name", userName)
	response, err := (&http.Client{Transport: project.Transport, Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		return RuntimeProfile{}, false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return RuntimeProfile{}, false, nil
	}
	if response.StatusCode != http.StatusOK {
		return RuntimeProfile{}, false, errors.New("Computer runtime resolution was rejected")
	}
	var resolved computerRuntimeResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&resolved) != nil || resolved.ComputerID != computerID {
		return RuntimeProfile{}, false, errors.New("Computer runtime response is invalid")
	}
	profile := RuntimeProfile{
		ID: resolved.AgentID, DisplayName: resolved.DisplayName, ProviderBaseURL: resolved.ProviderBaseURL,
		Model: resolved.Model, ModelCredentialID: resolved.ModelCredentialID, SearchCredentialID: resolved.SearchCredentialID,
		MaxTurns: resolved.MaxTurns, TimeoutSeconds: resolved.TimeoutSeconds,
	}
	if err := profile.Validate(); err != nil {
		return RuntimeProfile{}, false, err
	}
	return profile, true, nil
}
