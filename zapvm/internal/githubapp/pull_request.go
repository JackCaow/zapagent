package githubapp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"zapvm/internal/gitprovider"
)

const maxGitHubAPIResponse = 256 << 10

type pullRequestResponse struct {
	Number   uint64  `json:"number"`
	HTMLURL  string  `json:"html_url"`
	State    string  `json:"state"`
	MergedAt *string `json:"merged_at"`
	Head     struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
}

func (broker *Broker) ReconcilePullRequest(ctx context.Context, tenantID, projectID, providerID, operationID, branch, commitSHA string) (gitprovider.PullRequest, error) {
	if broker == nil || ctx == nil || !validCanonical(operationID, 128, false) || branch != "zapvm/"+operationID || !validObjectID(commitSHA) {
		return gitprovider.PullRequest{}, &gitprovider.ProviderError{Code: "pull_request_invalid"}
	}
	provision, exists := broker.installations[provisionKey(tenantID, projectID, providerID)]
	if !exists {
		return gitprovider.PullRequest{}, &gitprovider.ProviderError{Code: "pull_request_provider_missing"}
	}
	capability, err := broker.Mint(ctx, tenantID, projectID, providerID)
	if err != nil {
		return gitprovider.PullRequest{}, &gitprovider.ProviderError{Code: "pull_request_token_unavailable", Retryable: true}
	}
	defer capability.Destroy()
	if existing, found, err := broker.findPullRequest(ctx, provision, capability.Token, branch, commitSHA); err != nil {
		return gitprovider.PullRequest{}, err
	} else if found {
		return existing, nil
	}
	body := map[string]any{
		"title": "zapVM Agent operation " + operationID,
		"body":  "Automated delivery from a zapVM Agent Task.\n\nOperation: `" + operationID + "`\nCommit: `" + commitSHA + "`",
		"head":  branch, "base": provision.config.DefaultBaseBranch, "draft": false, "maintainer_can_modify": false,
	}
	endpoint := provision.config.APIBaseURL + "/repos/" + provision.config.Owner + "/" + provision.config.Repository + "/pulls"
	data, status, err := broker.githubJSON(ctx, http.MethodPost, endpoint, capability.Token, body)
	if err != nil {
		return gitprovider.PullRequest{}, err
	}
	if status == http.StatusUnprocessableEntity {
		if existing, found, findErr := broker.findPullRequest(ctx, provision, capability.Token, branch, commitSHA); findErr != nil {
			return gitprovider.PullRequest{}, findErr
		} else if found {
			return existing, nil
		}
		return gitprovider.PullRequest{}, &gitprovider.ProviderError{Code: "pull_request_rejected"}
	}
	if status != http.StatusCreated {
		return gitprovider.PullRequest{}, classifyGitHubStatus(status)
	}
	var response pullRequestResponse
	if err := json.Unmarshal(data, &response); err != nil {
		return gitprovider.PullRequest{}, &gitprovider.ProviderError{Code: "pull_request_response_invalid"}
	}
	return validatePullRequest(provision.config, response, branch, commitSHA)
}

func (broker *Broker) findPullRequest(ctx context.Context, provision installation, token []byte, branch, commitSHA string) (gitprovider.PullRequest, bool, error) {
	query := url.Values{}
	query.Set("state", "all")
	query.Set("head", provision.config.Owner+":"+branch)
	query.Set("base", provision.config.DefaultBaseBranch)
	query.Set("per_page", "10")
	endpoint := provision.config.APIBaseURL + "/repos/" + provision.config.Owner + "/" + provision.config.Repository + "/pulls?" + query.Encode()
	data, status, err := broker.githubJSON(ctx, http.MethodGet, endpoint, token, nil)
	if err != nil {
		return gitprovider.PullRequest{}, false, err
	}
	if status != http.StatusOK {
		return gitprovider.PullRequest{}, false, classifyGitHubStatus(status)
	}
	var responses []pullRequestResponse
	if err := json.Unmarshal(data, &responses); err != nil || len(responses) > 1 {
		return gitprovider.PullRequest{}, false, &gitprovider.ProviderError{Code: "pull_request_response_invalid"}
	}
	if len(responses) == 0 {
		return gitprovider.PullRequest{}, false, nil
	}
	result, err := validatePullRequest(provision.config, responses[0], branch, commitSHA)
	if err != nil {
		return gitprovider.PullRequest{}, false, err
	}
	return result, true, nil
}

func (broker *Broker) githubJSON(ctx context.Context, method, endpoint string, token []byte, body any) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, 0, &gitprovider.ProviderError{Code: "pull_request_invalid"}
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, 0, &gitprovider.ProviderError{Code: "pull_request_invalid"}
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+string(token))
	request.Header.Set("X-GitHub-Api-Version", apiVersion)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := broker.client.Do(request)
	if err != nil {
		return nil, 0, &gitprovider.ProviderError{Code: "pull_request_unavailable", Retryable: true}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxGitHubAPIResponse+1))
	if err != nil || len(data) > maxGitHubAPIResponse {
		return nil, 0, &gitprovider.ProviderError{Code: "pull_request_response_invalid"}
	}
	return data, response.StatusCode, nil
}

func validatePullRequest(config Config, response pullRequestResponse, branch, commitSHA string) (gitprovider.PullRequest, error) {
	if response.Number == 0 || response.Head.Ref != branch || response.Head.SHA != commitSHA || response.Base.Ref != config.DefaultBaseBranch {
		return gitprovider.PullRequest{}, &gitprovider.ProviderError{Code: "pull_request_conflict"}
	}
	expectedURL := config.WebBaseURL + "/" + config.Owner + "/" + config.Repository + "/pull/" + strconv.FormatUint(response.Number, 10)
	if response.HTMLURL != expectedURL {
		return gitprovider.PullRequest{}, &gitprovider.ProviderError{Code: "pull_request_response_invalid"}
	}
	state := response.State
	if response.MergedAt != nil {
		state = "merged"
	}
	if state != "open" && state != "closed" && state != "merged" {
		return gitprovider.PullRequest{}, &gitprovider.ProviderError{Code: "pull_request_response_invalid"}
	}
	return gitprovider.PullRequest{Number: response.Number, URL: response.HTMLURL, State: state}, nil
}

func classifyGitHubStatus(status int) error {
	if status == http.StatusTooManyRequests || status >= 500 {
		return &gitprovider.ProviderError{Code: "pull_request_unavailable", Retryable: true}
	}
	return &gitprovider.ProviderError{Code: "pull_request_rejected"}
}

func validObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
