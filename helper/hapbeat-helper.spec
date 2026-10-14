# -*- mode: python ; coding: utf-8 -*-
# Bundled Hapbeat Helper — PyInstaller onedir build.
#
# onedir (not onefile): starts fast (no unpack to %TEMP% on each launch) and is
# a single process, so the desktop app can stop it with one kill.
# console=True: the app starts it hidden (windowsHide). A windowed build would
# leave sys.stdout as None and make the helper's `netsh` calls flash a console.
from PyInstaller.utils.hooks import collect_submodules, copy_metadata

hiddenimports = (
    collect_submodules('hapbeat_helper')
    + collect_submodules('websockets')
    + collect_submodules('zeroconf')
)
# `hapbeat-helper mcp` (AI agents) is not part of the desktop app.
hiddenimports = [m for m in hiddenimports if not m.startswith('hapbeat_helper.mcp_server')]

a = Analysis(
    ['entry.py'],
    pathex=[],
    binaries=[],
    # __version__ falls back to importlib.metadata outside a git checkout.
    datas=copy_metadata('hapbeat-helper'),
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['mcp', 'pydantic', 'tkinter'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    # Unbuffered stdout/stderr: the app reads them through a pipe into its log.
    [('u', None, 'OPTION')],
    exclude_binaries=True,
    name='hapbeat-helper',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='hapbeat-helper',
)
