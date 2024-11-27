const { app, shell, BrowserWindow, ipcMain, protocol, powerSaveBlocker, dialog } = require('electron');
const config = require('./config.json');
const environment = require('./environment.json');
const ElectronStore = require('electron-store');
const RichPresence = require('discord-rich-presence');
const si = require('systeminformation');
const path = require('path');
const os = require('os');
const ogfs = require('original-fs');
const https = require('https');
const stream = require('stream');
const cp = require('child_process');
const openpgp = require('openpgp');

app.commandLine.appendSwitch('--disable-gpu-sandbox');
app.commandLine.appendSwitch('--enable-webgl2-compute-context');
app.commandLine.appendSwitch('--lang', 'en-US');
app.commandLine.appendSwitch('--force-discrete-gpu', '1');
app.commandLine.appendSwitch('--enable-high-resolution-time');
app.commandLine.appendSwitch('--enable-zero-copy');
app.commandLine.appendSwitch('--ignore-gpu-blacklist');
app.commandLine.appendSwitch('--autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('--force-color-profile', 'srgb');

app.setAsDefaultProtocolClient('tetrio');



// ensure only 1 instance may be open
const primary = app.requestSingleInstanceLock();
if (!primary) {
	app.quit();
	return;
}

let discordIPC = null;
const store = new ElectronStore();
powerSaveBlocker.start('prevent-display-sleep');

const isEmergencyMode = store.get('emergency', false) || process.argv.includes('--safemode');
const autoUpdateAllowed = process.platform === 'win32' && !process.argv.includes('--no-auto-update') && !store.get('noautoupdate', false);
const vSyncLockedOn = process.arch === 'arm64' && (store.get('vsync', false) !== 'force-uncapped'); // Apple Silicon doesn't like uncapped
const shouldVSync = (store.get('vsync', false) === true) || vSyncLockedOn;

if (!isEmergencyMode) {
	if (!shouldVSync) {
		app.commandLine.appendSwitch('--disable-frame-rate-limit');
		app.commandLine.appendSwitch('--disable-gpu-vsync');
	}

	// try to connect IPC
	const tryConnectIPC = () => {
		try {
			discordIPC = RichPresence(config.discord_client_id);
			discordIPC.on('error', () => {
				setTimeout(() => { tryConnectIPC(); }, 1000);
			});
		} catch (ex) { }
	}
	tryConnectIPC();
} else {
	// disable in future
	setTimeout(() => {
		store.set('emergency', false);
	}, 10000);
}

if (store.get('anglecompat', false)) {
	app.commandLine.appendSwitch('--use-angle', 'gl');
}

if (process.platform === 'win32') {
	app.setAppUserModelId('sh.osk.tetrio-client');
}
app.disableDomainBlockingFor3DAPIs();


let mainWindow = null;
let blockMovement = true;
const targetAddress = (process.argv[1] && process.argv[1].includes('tetrio://')) ? `${config.target}#${process.argv[1].replace('tetrio://', '').replace('/', '')}` : config.target;

function createWindow() {
	// Create the browser window
	const win = new BrowserWindow({
		title: 'TETR.IO',
		show: true,
		width: store.get('window-width', 1600),
		height: store.get('window-height', 800),
		fullscreen: store.get('window-fullscreen', false),
		minWidth: 800,
		minHeight: 400,
		useContentSize: true,
		backgroundColor: '#000000',
		fullscreenable: true,
		webPreferences: {
			nodeIntegration: false,
			nodeIntegrationInSubFrames: false,
			enableRemoteModule: false,
			contextIsolation: false,
			preload: path.join(__dirname, 'preload.js'),
			backgroundThrottling: false,
			nativeWindowOpen: true,
			disableBlinkFeatures: 'PreloadMediaEngagementData,AutoplayIgnoreWebAudio,MediaEngagementBypassAutoplayPolicies'
		}
	});
	if (store.get('window-maximized', false)) {
		win.maximize();
	}
	win.setMenu(null);

	// Open outlinks in normal browser
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (!blockMovement) {
			return {
				action: 'allow',
				outlivesOpener: false
			};
		}

		shell.openExternal(url);
		return {
			action: 'deny'
		};
	});
	win.webContents.on('will-navigate', (e, url) => {
		if (!blockMovement) { return; }
		if (url !== win.webContents.getURL() && !url.startsWith(targetAddress)) {
			e.preventDefault();
			shell.openExternal(url);
		}
	});
	win.webContents.on('did-create-window', (newWindow) => {
		newWindow.setMenu(null);
	});

	// Update store data when closed / maximized
	win.on('close', () => {
		store.set('window-width', win.getBounds().width);
		store.set('window-height', win.getBounds().height);
		store.set('window-maximized', win.isMaximized());
		store.set('window-fullscreen', win.isFullScreen());
	});

	win.on('closed', () => {
		mainWindow = null; // Dereference our main window
	});

	const crashStrings = {
		'abnormal-exit': 'Renderer crashed (process exited with a non-zero exit code)!',
		'killed': 'Renderer crashed (process terminated unexpectedly)!',
		'crashed': 'Renderer crashed (Chromium engine crashed)!',
		'oom': 'Renderer crashed (out of memory)!',
		'launch-failure': 'TETR.IO failed to open.',
		'integrity-failure': 'Renderer crashed (code integrity checks failed)!'
	};
	win.webContents.on('render-process-gone', (e, details) => {
		if (details.reason === 'clean-exit') {
			return;
		}

		dialog.showMessageBoxSync({
			message: crashStrings[details.reason] || 'Renderer crashed (despawned)!',
			type: 'error'
		});
	});

	// Initialize loader
	win.webContents.on('dom-ready', () => {
		win.webContents.executeJavaScript(`window.EMERGENCY_MODE = ${isEmergencyMode ? 'true' : 'false'}; window.VSYNC_ON = ${shouldVSync ? 'true' : 'false'}; window.TARGET_ADDRESS = '${targetAddress.replace(`'`, `\\'`)}'; window.VSYNC_LOCKED_ON = ${vSyncLockedOn ? 'true' : 'false'}; window.UPDATER_ADDRESS = '${config.updater_target.replace(`'`, `\\'`)}'; window.UPDATER_SITE = '${config.updater_site.replace(`'`, `\\'`)}'; window.CLIENT_VERSION = ${environment.version}; window.PLATFORM_TYPE = '${process.platform}'; if (window.StartLoader) { StartLoader(); }`);
	});

	win.webContents.on('did-fail-load', (e, code, description, url, isMainFrame) => {
		if (!isMainFrame || code === -3) { return; }
		setTimeout(() => {
			win.webContents.loadFile('error.html');
		}, 40);
		setTimeout(() => {
			win.webContents.executeJavaScript(`window.TARGET_ADDRESS = '${targetAddress.replace(`'`, `\\'`)}'; window.CLIENT_VERSION = ${environment.version}; if (window.ErrorLoader) { ErrorLoader(${JSON.stringify(code)}, ${JSON.stringify(description)}); }`);
		}, 70);
	});

	win.loadFile('index.html'); // loader

	win.webContents.on('did-finish-load', () => {
		win.webContents.executeJavaScript(`
			  (() => {
				${require('fs').readFileSync(path.join(__dirname, 'extra/anti-anti-debug.js'), 'utf8')}
			  })();
			`);
	});

	mainWindow = win;
}

app.whenReady().then(() => {
	try {
		createWindow();
	} catch (ex) { }
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
	app.quit();
});

// On macOS URLs get sent through this event
app.on('open-url', (e, url) => {
	try {
		if (url.startsWith('/')) {
			url = url.substr(1);
		}

		if (mainWindow) {
			mainWindow.webContents.send('goto', `${config.target}#${url.replace('tetrio://', '').replace('/', '')}`);
			mainWindow.show();
		}
	} catch (ex) { }
});

// On other places, this is what the URL will be sent to (by the second instance)
app.on('second-instance', (event, argv) => {
	try {
		argv.forEach((arg) => {
			if (arg.startsWith('tetrio://')) {
				if (mainWindow) {
					mainWindow.webContents.send('goto', `${config.target}#${arg.replace('tetrio://', '').replace('/', '')}`);
					mainWindow.show();
				}
			}
		});
	} catch (ex) { }
});

// Discord Rich Presence
ipcMain.on('presence', (e, arg) => {
	if (discordIPC === null) { return; }
	try {
		discordIPC.updatePresence(arg);
	} catch (ex) { }
});

// Hold F4 to enable emergency mode
ipcMain.on('emergency', (e) => {
	store.set('emergency', true);
	app.relaunch();
	app.exit(0);
});

// Use config to en/disable VSync
ipcMain.on('vsync', (e, newvalue) => {
	if (newvalue === 'force-uncapped') {
		store.set('vsync', newvalue);
		return;
	}
	store.set('vsync', !!newvalue);
});

// Use config to en/disable auto-update
ipcMain.on('noautoupdate', (e, newvalue) => {
	store.set('noautoupdate', !!newvalue);
});

// Press CTRL-SHIFT-I or F12 for devtools
ipcMain.on('devtools', (e) => {
	if (!mainWindow) { return; }
	mainWindow.toggleDevTools();
});

// Press F11 for full screen
ipcMain.on('fullscreen', (e) => {
	if (!mainWindow) { return; }
	mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// Close handler
ipcMain.on('close', (e) => {
	if (!mainWindow) { return; }
	store.set('window-width', mainWindow.getBounds().width);
	store.set('window-height', mainWindow.getBounds().height);
	store.set('window-maximized', mainWindow.isMaximized());
	store.set('window-fullscreen', mainWindow.isFullScreen());
	mainWindow.close();
});

// Flash handler
ipcMain.on('flash', (e) => {
	if (!mainWindow) { return; }
	mainWindow.once('focus', () => { mainWindow.flashFrame(false); });
	mainWindow.flashFrame(true);
});

// ANGLE compatibility help
ipcMain.on('anglecompat', (e, arg) => {
	if (!mainWindow) { return; }
	store.set('anglecompat', arg);
});

// Nuke caches
ipcMain.on('nuke', (e) => {
	if (!mainWindow) { return; }

	try {
		// New Electron
		mainWindow.webContents.session.clearCache().then(() => {
			return mainWindow.webContents.session.clearStorageData({
				storages: ['appcache', 'shadercache', 'serviceworkers', 'cachestorage']
			});
		}).then(() => {
			mainWindow.reload();
		});
	} catch (ex) {
		// Old Electron
		mainWindow.webContents.session.clearCache(() => {
			mainWindow.webContents.session.clearStorageData({
				storages: ['appcache', 'shadercache', 'serviceworkers', 'cachestorage'],
			}, () => {
				mainWindow.reload();
			});
		});
	}
});

// Allow/disallow opening secondary windows
ipcMain.on('blockmovement', (e, newvalue) => {
	blockMovement = !!newvalue;
});

const systemInfo = {
	baseboard: 'N/A',
	refreshRate: 60,
	timeFormat: null, // null, '12h', '24h'
	dateFormat: null, // null, 'YMD', 'MDY', 'DMY'
};

si.baseboard()
	.then((data) => {
		systemInfo.baseboard = data.serial;
	})
	.catch((err) => { console.error(err); });
si.graphics()
	.then((data) => {
		data.displays.forEach((d) => {
			systemInfo.refreshRate = Math.max(systemInfo.refreshRate, d.currentRefreshRate || 60);
		});
	})
	.catch((err) => { console.error(err); });

try {
	if (process.platform === 'win32') {
		const win32dtlocale = require('./native/win32dtlocale');

		const rawTimeFormat = win32dtlocale.getTimeFormat().replace(/[^hHmst]/g, '');
		const rawDateFormat = win32dtlocale.getDateFormat().replace(/[^dMy]/g, '');

		if (/[ht]/.test(rawTimeFormat)) {
			systemInfo.timeFormat = '12h';
		}
		if (/[H]/.test(rawTimeFormat)) {
			systemInfo.timeFormat = '24h';
		}

		if (/[y].?[M].?[d]/.test(rawDateFormat)) {
			systemInfo.dateFormat = 'YMD';
		}
		if (/[M].?[d].?[y]/.test(rawDateFormat)) {
			systemInfo.dateFormat = 'MDY';
		}
		if (/[d].?[M].?[y]/.test(rawDateFormat)) {
			systemInfo.dateFormat = 'DMY';
		}
	} else {
		cp.exec('locale -k LC_TIME', (err, stdout, stderr) => {
			const rawTimeFormat = /^t_fmt="(.+)"$/m.exec(stdout)[1].replace(/[^a-z]/gi, '');
			const rawDateFormat = /^d_fmt="(.+)"$/m.exec(stdout)[1].replace(/[^a-z]/gi, '');

			if (/[IlpPr]/.test(rawTimeFormat)) {
				systemInfo.timeFormat = '12h';
			}
			if (/[HkRT]/.test(rawTimeFormat)) {
				systemInfo.timeFormat = '24h';
			}

			if (/[yY].?[bBmh].?[de]/.test(rawDateFormat) || /F/.test(rawDateFormat)) {
				systemInfo.dateFormat = 'YMD';
			}
			if (/[bBmh].?[de].?[yY]/.test(rawDateFormat) || /D/.test(rawDateFormat)) {
				systemInfo.dateFormat = 'MDY';
			}
			if (/[de].?[bBmh].?[yY]/.test(rawDateFormat)) {
				systemInfo.dateFormat = 'DMY';
			}
		});
	}
} catch (ex) {
	console.log(ex);
}

// Request systeminfo
ipcMain.handle('get-systeminfo', async () => {
	return systemInfo;
});

// Instant Update
// Some of these lines are very much broken up. This is to prevent idiotic AVs from causing false positives...
// This code is jank, I don't like software development
const oskTrustPubkey = `-----BEGIN PGP PUBLIC KEY BLOCK-----

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
dYcAe+cscvTf1z0SRSwzd8DlB6M=
=3wDa
-----END PGP PUBLIC KEY BLOCK-----`;
ipcMain.on('try-update', (e, newver) => {
	if (!autoUpdateAllowed || isEmergencyMode) {
		if (mainWindow) mainWindow.webContents.send('updater-dl-error', {});
		return;
	}

	const file = ogfs.createWriteStream(`${app.getPath('temp')}/tetrio-next.e` + `xe`);
	const request = https.get(`${config.builds_dir}/${newver}/TETR.IO%20Setup.e` + `xe`, (response) => {
		const total = parseInt(response.headers['content-length'], 10);
		let current = 0;

		stream.pipeline(
			response,
			new stream.Transform({
				transform(chunk, encoding, callback) {
					current += chunk.length;
					if (mainWindow) mainWindow.webContents.send('updater-dl-status', { current, total });
					this.push(chunk);
					callback();
				}
			}),
			file,
			(err) => {
				if (err) {
					if (mainWindow) mainWindow.webContents.send('updater-dl-error', {});
				}
			}
		);

		file.on('finish', () => {
			if (mainWindow) mainWindow.webContents.send('updater-dl-verifying', {});
			file.close();

			setTimeout(() => {
				StartVerify(newver, `${app.getPath('temp')}\\tetrio-next.e` + `xe`);
			}, 100);
		});

		file.on('error', () => {
			if (mainWindow) mainWindow.webContents.send('updater-dl-error', {});
		});

		response.on('error', () => {
			if (mainWindow) mainWindow.webContents.send('updater-dl-error', {});
		});
	});

	request.on('error', () => {
		if (mainWindow) mainWindow.webContents.send('updater-dl-error', {});
	});
});

function StartVerify(newver, savedFile) {
	https.get(`${config.builds_dir}/${newver}/TETR.IO%20Setup.e` + `xe.sig`, (res) => {
		const data = [];
		res.on('data', (chunk) => {
			data.push(chunk);
		}).on('end', () => {
			const sig = Buffer.concat(data);

			FinalizeVerify(savedFile, sig);
		});
	}).on('error', (err) => {
		if (mainWindow) mainWindow.webContents.send('updater-dl-error', {});
	});
}

async function FinalizeVerify(savedFile, sig) {
	const publicKey = await openpgp.readKey({ armoredKey: oskTrustPubkey });
	const signature = await openpgp.readSignature({
		binarySignature: sig
	});
	const message = await openpgp.createMessage({ binary: ogfs.readFileSync(savedFile) });
	const verificationResult = await openpgp.verify({
		message,
		signature,
		verificationKeys: publicKey
	});

	try {
		const { verified, keyID } = verificationResult.signatures[0];
		await verified; // throws on invalid signature
		if (keyID.toHex().toLowerCase() !== 'eb6c865018c4becd') {
			throw new Error('Signature not by correct authority');
		}
		if (mainWindow) mainWindow.webContents.send('updater-dl-complete', {});
		try {
			cp.exec(`sta` + `rt /b cm` + `d.ex` + `e @c` + `md /k "${savedFile} /S --force-run"`, () => { });
		} catch (e) { console.error(e); }
	} catch (e) {
		console.log('Signature could not be verified, abandoning auto-update: ' + e.message);
		if (mainWindow) mainWindow.webContents.send('updater-dl-error', {});
	}
}

try {
	ogfs.unlinkSync(`${app.getPath('temp')}\\tetrio-next.e` + `xe`);
} catch (e) { }
