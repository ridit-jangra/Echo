const { execSync } = require('child_process')
const { rmSync } = require('fs')
const { join, delimiter } = require('path')

// usocket fails to build on Windows and crashes with a V8 sandbox SIGABRT
// on Linux/Electron 31+ (see dbus-next/lib/connection.js). dbus-next falls
// back to a plain net socket when it's missing, so remove it everywhere.
rmSync(join(__dirname, '..', 'node_modules', 'usocket'), { recursive: true, force: true })

execSync('electron-builder install-app-deps', {
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: join(__dirname, '..', 'node_modules', '.bin') + delimiter + process.env.PATH
  }
})
