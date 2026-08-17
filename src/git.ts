import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Access to the built-in Git extension: the current branch (comments are
 * branch-scoped) and the diff hunks quoted alongside a review comment.
 */

export function getGitApi(): any | undefined {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension?.isActive) return undefined;
    return gitExtension.exports.getAPI(1);
}

export interface DiffHunk {
    header: string;
    lines: string[];
}

export async function getFileDiffHunks(uri: vscode.Uri): Promise<DiffHunk[]> {
    try {
        const git = getGitApi();
        if (!git) return [];
        const repo = git.repositories.find((r: any) =>
            uri.fsPath.startsWith(r.rootUri.fsPath)
        );
        if (!repo) return [];

        // Get unstaged diff (working tree vs index)
        const unstaged = await repo.diff(false) || '';
        // Get staged diff (index vs HEAD)
        const staged = await repo.diff(true) || '';
        // Combine — unstaged first since it reflects current file state
        const fullDiff = unstaged + '\n' + staged;

        if (!fullDiff.trim()) return [];

        const rel = path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');

        // Split diff into per-file sections
        const fileSections = fullDiff.split(/^(?=diff --git )/m);
        const targetPrefix = `diff --git a/${rel} b/${rel}`;
        const fileSection = fileSections.find(s => s.startsWith(targetPrefix));
        if (!fileSection) return [];

        // Split into hunks by @@ markers
        const hunkParts = fileSection.split(/^(?=@@)/m);
        const hunks: DiffHunk[] = [];

        for (const part of hunkParts) {
            if (!part.startsWith('@@')) continue;
            const lines = part.split('\n');
            const header = lines[0];
            const body = lines.slice(1).filter(l => l !== '' || lines.indexOf(l) < lines.length - 1);
            hunks.push({ header, lines: body });
        }

        return hunks;
    } catch {
        return [];
    }
}

export function findRelevantHunk(hunks: DiffHunk[], targetLine: number): string | undefined {
    for (const hunk of hunks) {
        // Parse @@ -oldStart,oldCount +newStart,newCount @@
        const m = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!m) continue;

        const newStart = parseInt(m[3], 10);
        const newCount = parseInt(m[4] ?? '1', 10);
        const newEnd = newStart + newCount - 1;

        // Target line is 1-based
        if (targetLine >= newStart && targetLine <= newEnd) {
            // Return the hunk with limited context (max 15 lines around comment)
            const allLines = [hunk.header, ...hunk.lines];
            if (allLines.length <= 20) return allLines.join('\n');
            // Find the approximate position in the hunk
            let newLineCounter = newStart;
            let bestIndex = 1; // skip header
            for (let i = 1; i < allLines.length; i++) {
                const line = allLines[i];
                if (!line.startsWith('-')) {
                    if (newLineCounter === targetLine) {
                        bestIndex = i;
                        break;
                    }
                    newLineCounter++;
                }
            }
            const start = Math.max(1, bestIndex - 7);
            const end = Math.min(allLines.length, bestIndex + 7);
            return [hunk.header, ...allLines.slice(start, end)].join('\n');
        }
    }
    return undefined;
}
