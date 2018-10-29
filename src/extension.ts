/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RipgrepFileSearchEngine } from './ripgrepFileSearch';
import { RipgrepTextSearchEngine } from './ripgrepTextSearch';

export function activate(): void {
	const outputChannel = vscode.window.createOutputChannel('search-rg');

	const provider = new RipgrepSearchProvider(outputChannel);
	vscode.workspace.registerFileIndexProvider('file', provider);
	vscode.workspace.registerTextSearchProvider('file', provider);
}

class RipgrepSearchProvider implements vscode.FileIndexProvider, vscode.TextSearchProvider {
	private inProgress: Set<vscode.CancellationTokenSource> = new Set();

	constructor(private outputChannel: vscode.OutputChannel) {
		process.once('exit', () => this.dispose());
	}

	provideTextSearchResults(query: vscode.TextSearchQuery, options: vscode.TextSearchOptions, progress: vscode.Progress<vscode.TextSearchResult>, token: vscode.CancellationToken): Promise<vscode.TextSearchComplete> {
		const engine = new RipgrepTextSearchEngine(this.outputChannel);
		return this.withToken(token, token => engine.provideTextSearchResults(query, options, progress, token));
	}

	provideFileIndex(options: vscode.FileSearchOptions, token: vscode.CancellationToken): Thenable<vscode.Uri[]> {
		const engine = new RipgrepFileSearchEngine(this.outputChannel);

		const results: vscode.Uri[] = [];
		const onResult = (relativePathMatch: string) => {
			results.push(vscode.Uri.file(options.folder.fsPath + '/' + relativePathMatch));
		};

		return this.withToken(token, token => engine.provideFileSearchResults(options, { report: onResult }, token))
			.then(() => results);
	}

	private async withToken<T>(token: vscode.CancellationToken, fn: (token: vscode.CancellationToken) => Thenable<T>): Promise<T> {
		const merged = mergedTokenSource(token);
		this.inProgress.add(merged);
		const result = await fn(merged.token);
		this.inProgress.delete(merged);

		return result;
	}

	private dispose() {
		this.inProgress.forEach(engine => engine.cancel());
	}
}

function mergedTokenSource(token: vscode.CancellationToken): vscode.CancellationTokenSource {
	const tokenSource = new vscode.CancellationTokenSource();
	token.onCancellationRequested(() => tokenSource.cancel());

	return tokenSource;
}
