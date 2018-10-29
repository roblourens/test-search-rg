/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { Readable } from 'stream';
import { NodeStringDecoder, StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';
import { normalizeNFC, normalizeNFD } from './normalization';
import { rgPath } from 'vscode-ripgrep';
import { rgErrorMsgForDisplay } from './ripgrepTextSearch';
import { anchorGlob, Maybe } from './utils';

const isMac = process.platform === 'darwin';

// If vscode-ripgrep is in an .asar file, then the binary is unpacked.
const rgDiskPath = rgPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');

export class RipgrepFileSearchEngine {
	constructor(private outputChannel: vscode.OutputChannel) { }

	provideFileSearchResults(options: vscode.FileSearchOptions, progress: vscode.Progress<string>, token: vscode.CancellationToken): Thenable<void> {
		this.outputChannel.appendLine(`provideFileSearchResults ${JSON.stringify({
			...options,
			...{
				folder: options.folder.toString()
			}
		})}`);

		return new Promise((resolve, reject) => {
			let isDone = false;

			const cancel = () => {
				isDone = true;
				if (rgProc) {
					rgProc.kill();
				}
			};

			token.onCancellationRequested(() => cancel());

			const rgArgs = getRgArgs(options);

			const cwd = options.folder.fsPath;

			const escapedArgs = rgArgs
				.map(arg => arg.match(/^-/) ? arg : `'${arg}'`)
				.join(' ');
			this.outputChannel.appendLine(`rg ${escapedArgs}\n - cwd: ${cwd}\n`);

			let rgProc: Maybe<cp.ChildProcess> = cp.spawn(rgDiskPath, rgArgs, { cwd });

			rgProc.on('error', e => {
				console.log(e);
				reject(e);
			});

			let leftover = '';
			this.collectStdout(rgProc, (err, stdout, last) => {
				if (err) {
					reject(err);
					return;
				}

				// Mac: uses NFD unicode form on disk, but we want NFC
				const normalized = leftover + (isMac ? normalizeNFC(stdout || '') : stdout);
				const relativeFiles = normalized.split('\n');

				if (last) {
					const n = relativeFiles.length;
					relativeFiles[n - 1] = relativeFiles[n - 1].trim();
					if (!relativeFiles[n - 1]) {
						relativeFiles.pop();
					}
				} else {
					leftover = <string>relativeFiles.pop();
				}

				if (relativeFiles.length && relativeFiles[0].indexOf('\n') !== -1) {
					reject(new Error('Splitting up files failed'));
					return;
				}

				relativeFiles.forEach(relativeFile => {
					progress.report(relativeFile);
				});

				if (last) {
					if (isDone) {
						resolve();
					} else {
						// Trigger last result
						rgProc = null;
						if (err) {
							reject(err);
						} else {
							resolve();
						}
					}
				}
			});
		});
	}

	private collectStdout(cmd: cp.ChildProcess, cb: (err?: Error, stdout?: string, last?: boolean) => void): void {
		let onData = (err?: Error, stdout?: string, last?: boolean) => {
			if (err || last) {
				onData = () => { };
			}

			cb(err, stdout, last);
		};

		let gotData = false;
		if (cmd.stdout) {
			// Should be non-null, but #38195
			this.forwardData(cmd.stdout, onData);
			cmd.stdout.once('data', () => gotData = true);
		} else {
			this.outputChannel.appendLine('stdout is null');
		}

		let stderr: Buffer[];
		if (cmd.stderr) {
			// Should be non-null, but #38195
			stderr = this.collectData(cmd.stderr);
		} else {
			this.outputChannel.appendLine('stderr is null');
		}

		cmd.on('error', (err: Error) => {
			onData(err);
		});

		cmd.on('close', (code: number) => {
			// ripgrep returns code=1 when no results are found
			let stderrText, displayMsg: Maybe<string>;
			if (!gotData && (stderrText = this.decodeData(stderr)) && (displayMsg = rgErrorMsgForDisplay(stderrText))) {
				onData(new Error(`command failed with error code ${code}: ${displayMsg}`));
			} else {
				onData(undefined, '', true);
			}
		});
	}

	private forwardData(stream: Readable, cb: (err?: Error, stdout?: string) => void): NodeStringDecoder {
		const decoder = new StringDecoder();
		stream.on('data', (data: Buffer) => {
			cb(undefined, decoder.write(data));
		});
		return decoder;
	}

	private collectData(stream: Readable): Buffer[] {
		const buffers: Buffer[] = [];
		stream.on('data', (data: Buffer) => {
			buffers.push(data);
		});
		return buffers;
	}

	private decodeData(buffers: Buffer[]): string {
		const decoder = new StringDecoder();
		return buffers.map(buffer => decoder.write(buffer)).join('');
	}
}

function getRgArgs(options: vscode.FileSearchOptions): string[] {
	const args = ['--files', '--hidden', '--case-sensitive'];

	options.includes.forEach(globArg => {
		const inclusion = anchorGlob(globArg);
		args.push('-g', inclusion);
		if (isMac) {
			const normalized = normalizeNFD(inclusion);
			if (normalized !== inclusion) {
				args.push('-g', normalized);
			}
		}
	});

	options.excludes.forEach(globArg => {
		const exclusion = `!${anchorGlob(globArg)}`;
		args.push('-g', exclusion);
		if (isMac) {
			const normalized = normalizeNFD(exclusion);
			if (normalized !== exclusion) {
				args.push('-g', normalized);
			}
		}
	});

	if (options.useIgnoreFiles) {
		args.push('--no-ignore-parent');
	} else {
		// Don't use .gitignore or .ignore
		args.push('--no-ignore');
	}

	// Follow symlinks
	if (options.followSymlinks) {
		args.push('--follow');
	}

	args.push('--no-config');
	if (!options.useGlobalIgnoreFiles) {
		args.push('--no-ignore-global');
	}

	return args;
}
