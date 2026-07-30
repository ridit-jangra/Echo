import { unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import * as dbus from 'dbus-next'
import { ECHO_BASE_DIR } from '../../../utils/env'

export type OpenWindow = { id: string; app: string; title: string }

type RemoteInterface = { [method: string]: (...args: unknown[]) => Promise<unknown> }

async function getRemote(
  bus: dbus.MessageBus,
  path: string,
  iface: string
): Promise<RemoteInterface> {
  const obj = await bus.getProxyObject('org.kde.KWin', path)
  return obj.getInterface(iface) as unknown as RemoteInterface
}

async function runKwinScript(body: string): Promise<string | null> {
  const bus = dbus.sessionBus()
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  const service = `org.echo.iris.once${tag}`
  const objectPath = '/org/echo/iris/once'
  const scriptName = `echo-iris-once-${tag}`
  const scriptFile = join(ECHO_BASE_DIR, `${scriptName}.js`)

  return await new Promise<string | null>((resolve) => {
    let settled = false
    let scripting: RemoteInterface | null = null

    const finish = (result: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void (async () => {
        await scripting?.unloadScript(scriptName).catch(() => {})
        try {
          bus.disconnect()
        } catch {
          // already gone
        }
        await unlink(scriptFile).catch(() => {})
        resolve(result)
      })()
    }

    const timer = setTimeout(() => finish(null), 3000)

    class ReportInterface extends dbus.interface.Interface {
      Report(payload: string): void {
        finish(payload)
      }
    }
    ReportInterface.configureMembers({ methods: { Report: { inSignature: 's' } } })

    void (async () => {
      try {
        const iface = new ReportInterface(service)
        bus.export(objectPath, iface)
        await bus.requestName(service, 0)

        const script = `function report(payload) {
  callDBus("${service}", "${objectPath}", "${service}", "Report", String(payload));
}
${body}
`
        await writeFile(scriptFile, script, 'utf-8')
        const scriptingIface = await getRemote(bus, '/Scripting', 'org.kde.kwin.Scripting')
        scripting = scriptingIface
        const reply = await bus.call(
          new dbus.Message({
            destination: 'org.kde.KWin',
            path: '/Scripting',
            interface: 'org.kde.kwin.Scripting',
            member: 'loadScript',
            signature: 'ss',
            body: [scriptFile, scriptName]
          })
        )
        const id = Number(reply?.body?.[0])

        let scriptObj: RemoteInterface
        try {
          scriptObj = await getRemote(bus, `/Scripting/Script${id}`, 'org.kde.kwin.Script')
        } catch {
          scriptObj = await getRemote(bus, `/${id}`, 'org.kde.kwin.Script')
        }
        await scriptObj.run()
      } catch (err) {
        console.error('[iris] kwin script failed:', err)
        finish(null)
      }
    })()
  })
}

export async function listWindows(): Promise<OpenWindow[]> {
  const payload = await runKwinScript(`
var wins = workspace.windowList().filter(function (w) {
  return !w.skipTaskbar && !w.deleted && w.normalWindow;
}).map(function (w) {
  return { id: String(w.internalId), app: String(w.resourceClass || ""), title: String(w.caption || "") };
});
report(JSON.stringify(wins));
`)
  if (!payload) return []
  try {
    return JSON.parse(payload) as OpenWindow[]
  } catch {
    return []
  }
}

export async function activateWindow(id: string): Promise<boolean> {
  const payload = await runKwinScript(`
var wins = workspace.windowList();
var found = false;
for (var i = 0; i < wins.length; i++) {
  if (String(wins[i].internalId) === ${JSON.stringify(id)}) {
    workspace.activeWindow = wins[i];
    found = true;
    break;
  }
}
report(found ? "true" : "false");
`)
  return payload === 'true'
}
