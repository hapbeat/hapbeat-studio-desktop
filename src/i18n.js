'use strict'
// The few texts the app itself shows (dialogs, offline page). Studio has its own.

const MESSAGES = {
  'serial.title': { ja: 'USB 機器の選択', en: 'Choose a USB device' },
  'serial.message': { ja: '接続する機器を選んでください。', en: 'Choose the device to connect.' },
  'serial.none.message': { ja: 'USB で接続された機器が見つかりません。', en: 'No USB device was found.' },
  'serial.none.detail': {
    ja: 'Hapbeat を USB ケーブルでつなぎ、もう一度お試しください。充電専用のケーブルでは認識されません。',
    en: 'Connect the Hapbeat with a USB cable and try again. A charge-only cable is not recognised.',
  },
  'serial.hapbeat': { ja: 'Hapbeat', en: 'Hapbeat' },
  'serial.unknown': { ja: 'USB シリアル機器', en: 'USB serial device' },
  'common.cancel': { ja: 'キャンセル', en: 'Cancel' },
  'common.ok': { ja: 'OK', en: 'OK' },
  'update.ready.message': { ja: '新しいバージョン {version} の準備ができました。', en: 'Version {version} is ready.' },
  'update.ready.detail': {
    ja: '再起動すると更新されます。「後で」を選ぶと、次にアプリを閉じたときに更新します。',
    en: 'Restart to update. Choose "Later" to update the next time you quit the app.',
  },
  'update.restart': { ja: '再起動して更新', en: 'Restart and update' },
  'update.later': { ja: '後で', en: 'Later' },
  'menu.view': { ja: '表示', en: 'View' },
  'menu.reload': { ja: '再読み込み', en: 'Reload' },
  'menu.help': { ja: 'ヘルプ', en: 'Help' },
  'menu.docs': { ja: '使い方（Web）', en: 'Documentation (web)' },
  'menu.logs': { ja: 'ログのフォルダを開く', en: 'Open the log folder' },
  'menu.updates': { ja: '更新を確認', en: 'Check for updates' },
  'menu.about': { ja: 'バージョン情報', en: 'About' },
  'update.none': { ja: '最新のバージョンです（{version}）。', en: 'You have the latest version ({version}).' },
  'update.downloading': { ja: '新しいバージョン {version} をダウンロードしています。準備ができたらお知らせします。', en: 'Downloading version {version}. You will be told when it is ready.' },
  'update.failed': { ja: '更新を確認できませんでした。', en: 'Could not check for updates.' },
  'update.dev': { ja: '開発用の起動では更新を確認しません。', en: 'Updates are not checked in a development run.' },
}

let locale = 'en'

function setLocale(appLocale) {
  locale = String(appLocale || '').toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

function t(key, params = {}) {
  const entry = MESSAGES[key]
  if (!entry) return key
  return entry[locale].replace(/\{(\w+)\}/g, (_, name) => (name in params ? String(params[name]) : `{${name}}`))
}

module.exports = { setLocale, t, getLocale: () => locale }
