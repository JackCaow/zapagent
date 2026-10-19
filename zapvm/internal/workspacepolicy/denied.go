package workspacepolicy

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	MaxDeniedPatterns     = 32
	MaxResolvedDeniedPath = 4096
	maxWorkspaceEntries   = 1_000_000
)

// ValidateDeniedPatterns accepts a deliberately small, Host-independent glob
// grammar. Patterns are workspace-relative POSIX paths; '*' matches one path
// component and '**/' matches any directory prefix. Absolute paths and parent
// traversal must be normalized by the protocol adapter before this boundary.
func ValidateDeniedPatterns(patterns []string) error {
	if len(patterns) > MaxDeniedPatterns {
		return fmt.Errorf("denied workspace patterns exceed limit %d", MaxDeniedPatterns)
	}
	seen := make(map[string]struct{}, len(patterns))
	for _, pattern := range patterns {
		if pattern == "" || len(pattern) > 4096 || !utf8.ValidString(pattern) || strings.IndexByte(pattern, 0) >= 0 {
			return errors.New("denied workspace pattern is empty, oversized, invalid UTF-8, or contains NUL")
		}
		if strings.Contains(pattern, "\\") || path.IsAbs(pattern) || pattern == "." || pattern == "*" || pattern == "**" || strings.ContainsAny(pattern, "?[]{}") {
			return fmt.Errorf("denied workspace pattern %q is outside the supported grammar", pattern)
		}
		for _, component := range strings.Split(pattern, "/") {
			if component == "" || component == "." || component == ".." || (strings.Contains(component, "**") && component != "**") {
				return fmt.Errorf("denied workspace pattern %q must be a clean relative POSIX pattern", pattern)
			}
		}
		if path.Clean(pattern) != pattern {
			return fmt.Errorf("denied workspace pattern %q must be clean", pattern)
		}
		if _, exists := seen[pattern]; exists {
			return fmt.Errorf("denied workspace pattern %q is repeated", pattern)
		}
		seen[pattern] = struct{}{}
	}
	return nil
}

// ResolveDeniedPaths expands supported patterns against the live workspace
// immediately before command launch. It never follows symlink directories and
// fails closed when a symlink aliases a denied target.
func ResolveDeniedPaths(root string, patterns []string) ([]string, error) {
	if err := ValidateDeniedPatterns(patterns); err != nil {
		return nil, err
	}
	if len(patterns) == 0 {
		return nil, nil
	}
	rootPath, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	rootInfo, err := os.Lstat(rootPath)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("workspace root must be an existing real directory")
	}
	matchers := make([]deniedMatcher, 0, len(patterns))
	for _, pattern := range patterns {
		matcher, err := compileDeniedMatcher(pattern)
		if err != nil {
			return nil, err
		}
		matchers = append(matchers, matcher)
	}
	resolved := make([]string, 0)
	entries := 0
	err = filepath.WalkDir(rootPath, func(target string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if target == rootPath {
			return nil
		}
		entries++
		if entries > maxWorkspaceEntries {
			return fmt.Errorf("workspace exceeds denied-path scan limit %d", maxWorkspaceEntries)
		}
		relative, err := filepath.Rel(rootPath, target)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		matched := matchesDeniedPath(relative, matchers)
		if entry.Type()&os.ModeSymlink != 0 {
			alias, aliasErr := filepath.EvalSymlinks(target)
			if aliasErr != nil {
				if matched {
					return fmt.Errorf("denied workspace path %q is an unresolved symlink", relative)
				}
				return nil
			}
			aliasRelative, relErr := filepath.Rel(rootPath, alias)
			if relErr == nil && aliasRelative != ".." && !strings.HasPrefix(aliasRelative, ".."+string(filepath.Separator)) && matchesDeniedPath(filepath.ToSlash(aliasRelative), matchers) {
				return fmt.Errorf("workspace symlink %q aliases a denied path", relative)
			}
			return nil
		}
		if !matched {
			return nil
		}
		if len(resolved) >= MaxResolvedDeniedPath {
			return fmt.Errorf("resolved denied workspace paths exceed limit %d", MaxResolvedDeniedPath)
		}
		resolved = append(resolved, target)
		if entry.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("resolve denied workspace paths: %w", err)
	}
	sort.Strings(resolved)
	return resolved, nil
}

type deniedMatcher struct {
	exact  string
	prefix string
	regex  *regexp.Regexp
}

func compileDeniedMatcher(pattern string) (deniedMatcher, error) {
	if !strings.Contains(pattern, "*") {
		return deniedMatcher{exact: pattern, prefix: pattern + "/"}, nil
	}
	var expression strings.Builder
	expression.WriteByte('^')
	for index := 0; index < len(pattern); index++ {
		character := pattern[index]
		if character == '*' && index+1 < len(pattern) && pattern[index+1] == '*' {
			if index+2 < len(pattern) && pattern[index+2] == '/' {
				expression.WriteString("(?:.*/)?")
				index += 2
				continue
			}
			expression.WriteString(".*")
			index++
			continue
		}
		if character == '*' {
			expression.WriteString("[^/]*")
			continue
		}
		expression.WriteString(regexp.QuoteMeta(string(character)))
	}
	expression.WriteByte('$')
	compiled, err := regexp.Compile(expression.String())
	if err != nil {
		return deniedMatcher{}, fmt.Errorf("compile denied workspace pattern %q: %w", pattern, err)
	}
	return deniedMatcher{regex: compiled}, nil
}

func matchesDeniedPath(relative string, matchers []deniedMatcher) bool {
	for _, matcher := range matchers {
		if matcher.regex != nil && matcher.regex.MatchString(relative) || matcher.exact != "" && (relative == matcher.exact || strings.HasPrefix(relative, matcher.prefix)) {
			return true
		}
	}
	return false
}
