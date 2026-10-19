package main

import (
	"context"
	"errors"

	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/hostgit"
	"zapvm/internal/workspacefs"
)

func (server *daemonServer) workspaceExplorer(computerID string) (*workspacefs.Explorer, error) {
	if server.computers == nil {
		return nil, errors.New("Agent Computer store is unavailable")
	}
	record, err := server.computers.Get(computerID)
	if err != nil {
		return nil, errors.New("Agent Computer is unavailable")
	}
	return workspacefs.New(record.Workspace)
}

func (server *daemonServer) pushComputerGit(ctx context.Context, request daemonrpc.ComputerGitPushRequest) (daemonrpc.GitPushResult, error) {
	defer credential.ZeroBytes(request.Token)
	if server.computers == nil {
		return daemonrpc.GitPushResult{}, errors.New("invalid_worktree")
	}
	record, err := server.computers.Get(request.ComputerID)
	if err != nil {
		return daemonrpc.GitPushResult{}, errors.New("invalid_worktree")
	}
	return hostgit.Push(ctx, record.Workspace, request)
}

func (server *daemonServer) listComputerWorkspace(request daemonrpc.ComputerWorkspaceRequest) (daemonrpc.WorkspaceListing, error) {
	explorer, err := server.workspaceExplorer(request.ComputerID)
	if err != nil {
		return daemonrpc.WorkspaceListing{}, err
	}
	listing, err := explorer.List(request.Path)
	if err != nil {
		return daemonrpc.WorkspaceListing{}, err
	}
	entries := make([]daemonrpc.WorkspaceEntry, 0, len(listing.Entries))
	for _, entry := range listing.Entries {
		entries = append(entries, daemonrpc.WorkspaceEntry{
			Path: entry.Path, Name: entry.Name, Type: entry.Type, Size: entry.Size, ModifiedAt: entry.ModifiedAt,
		})
	}
	return daemonrpc.WorkspaceListing{Path: listing.Path, Entries: entries, Truncated: listing.Truncated}, nil
}

func (server *daemonServer) readComputerWorkspace(request daemonrpc.ComputerWorkspaceRequest) (daemonrpc.WorkspaceFile, error) {
	explorer, err := server.workspaceExplorer(request.ComputerID)
	if err != nil {
		return daemonrpc.WorkspaceFile{}, err
	}
	file, err := explorer.Read(request.Path)
	if err != nil {
		return daemonrpc.WorkspaceFile{}, err
	}
	return daemonrpc.WorkspaceFile{
		Path: file.Path, Size: file.Size, SHA256: file.SHA256, ContentType: file.ContentType, Data: file.Data,
	}, nil
}

func (server *daemonServer) diffComputerWorkspace(ctx context.Context, request daemonrpc.ComputerWorkspaceRequest) (daemonrpc.WorkspaceDiff, error) {
	explorer, err := server.workspaceExplorer(request.ComputerID)
	if err != nil {
		return daemonrpc.WorkspaceDiff{}, err
	}
	diff, err := explorer.GitDiff(ctx, request.Path)
	if err != nil {
		return daemonrpc.WorkspaceDiff{}, err
	}
	return daemonrpc.WorkspaceDiff{Path: diff.Path, Size: diff.Size, SHA256: diff.SHA256, Data: diff.Data}, nil
}
