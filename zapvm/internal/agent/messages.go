package agent

type ExecStart struct {
	Argv                    []string          `json:"argv"`
	Cwd                     string            `json:"cwd,omitempty"`
	Env                     map[string]string `json:"env,omitempty"`
	Credentials             map[string][]byte `json:"credentials,omitempty"`
	ProtectedWorkspacePaths []string          `json:"protected_workspace_paths,omitempty"`
	DeniedWorkspacePatterns []string          `json:"denied_workspace_patterns,omitempty"`
	TimeoutMillis           uint64            `json:"timeout_ms,omitempty"`
}

type ExecStarted struct {
	PID int `json:"pid"`
}

type ExecOutput struct {
	Data []byte `json:"data"`
}

type ExecExit struct {
	Code int `json:"code"`
}

type ExecSignal struct {
	Signal string `json:"signal"`
}

type ErrorMessage struct {
	Message string `json:"message"`
}

type Health struct {
	ProtocolVersion int    `json:"protocol_version"`
	InstanceID      string `json:"instance_id"`
	StateSchema     int    `json:"state_schema"`
	ActiveCommands  int    `json:"active_commands"`
	UptimeMillis    int64  `json:"uptime_ms"`
}
