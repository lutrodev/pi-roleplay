import { createConnection } from 'node:net'
import { join } from 'node:path'

const command = process.argv[2]
if (!command || !['status', 'quiesce', 'resume'].includes(command)) {
  process.stderr.write('用法：node dist/ops.js status|quiesce|resume\n')
  process.exitCode = 1
} else {
  const socket = createConnection(process.env.RP_CONTROL_SOCKET ?? join(process.env.RP_DATA_DIR ?? './data', 'admin.sock'))
  socket.setTimeout(6000, () => socket.destroy(new Error('timeout')))
  socket.on('connect', () => socket.write(JSON.stringify({ command }) + '\n'))
  let output = ''
  socket.on('data', bytes => { output += bytes; if (output.length > 16384) socket.destroy(new Error('oversize')) })
  socket.on('end', () => {
    try { const result = JSON.parse(output); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.ok) process.exitCode = 1 }
    catch { process.stderr.write('本地控制接口返回无效结果。\n'); process.exitCode = 1 }
  })
  socket.on('error', () => { process.stderr.write('无法连接应用本地控制接口，请检查 app 服务状态。\n'); process.exitCode = 1 })
}
