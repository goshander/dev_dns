const fs = require('fs')
const path = require('path')
const dns2 = require('dns2')
const chokidar = require('chokidar')

const traefik = require('./traefik')
const local = require('./local')
const run = require('./run')
const install = require('./install')
const uninstall = require('./uninstall')
const help = require('./help')
const env = require('./env')
const logo = require('./logo')

async function init(config) {
  let server
  let tResolve

  try {
    const primaryDNS = config.dns && config.dns.primary ? {
      resolve: dns2.TCPClient({
        dns: config.dns.primary,
      }),
      dns: config.dns.primary,
    } : null

    const secondaryDNS = config.dns && config.dns.secondary ? {
      resolve: dns2.TCPClient({
        dns: config.dns.secondary,
      }),
      dns: config.dns.secondary,
    } : null

    if (config.docker.enable) {
      tResolve = await traefik.init(config.docker.refresh)
    }

    const lResolve = await local.init(config.local)

    server = dns2.createServer({
      udp: true,
      handle: async (request, send, rinfo) => {
        const response = dns2.Packet.createResponseFromRequest(request)
        const [question] = request.questions
        const { name } = question

        // traefik resolve
        const tName = tResolve != null ? tResolve.resolve(name) : null
        const lName = lResolve.resolve(name)

        if (tName) {
          response.answers.push({
            name,
            type: dns2.Packet.TYPE.A,
            class: dns2.Packet.CLASS.IN,
            ttl: 300,
            address: tName,
          })
        } else if (lName) {
          response.answers.push({
            name,
            type: dns2.Packet.TYPE.A,
            class: dns2.Packet.CLASS.IN,
            ttl: 300,
            address: lName,
          })
        } else {
          const dnsResult = []

          if (primaryDNS != null) {
            try {
              const pResult = await primaryDNS.resolve(name)
              dnsResult.push(...pResult.answers)
            } catch (err) {
              console.error('❌ error primary dns response:', config.dns.primary, '-', err.message)
            }
          }

          if (secondaryDNS != null && dnsResult.length < 1) {
            try {
              const sResult = await secondaryDNS.resolve(name)
              dnsResult.push(...sResult.answers)
            } catch (err) {
              console.error('❌ error secondary dns response:', config.dns.secondary, '-', err.message)
            }
          }

          response.answers.push(...dnsResult)
        }

        send(response)
      },
    })

    server.on('listening', (instance) => {
      console.log('⚙️  server ready...', instance.udp)
    })

    server.on('error', () => {
      console.log('❌ error host and port already in use,', `host: ${config.host}, port: ${config.port}`)
      process.exit(1)
    })

    await server.listen({
      udp: {
        address: config.host,
        port: config.port,
      },
    })
  } catch (err) {
    console.log('❌ error dns server,', `error: ${err.stack || err}`)
  }

  return {
    async  close() {
      try {
        if (server != null) await server.close()
        if (tResolve != null) await tResolve.close()
      } catch (_) {
        // pass
      }
    },
  }
}

function configLoad() {
  let configPath = './config.json'

  if (process.pkg) {
    configPath = path.join(path.dirname(process.argv[0]), 'config.json')
  }
  if (!fs.existsSync(configPath)) {
    configPath = path.join(process.cwd(), 'config.json')
  }

  let config = null
  if (!fs.existsSync(configPath)) {
    console.error('❌ config file not found:', configPath)
  } else {
    try {
      config = JSON.parse(fs.readFileSync(configPath).toString())
    } catch (err) {
      console.error('❌ config file json error:', configPath)
    }
  }

  return { config, configPath }
}

async function main() {
  let configSeed = configLoad()
  let watcher = null
  let server = null

  if (configSeed.config == null || (configSeed.config.watch && configSeed.config.watch.enable)) {
    let interval = 2000
    if (configSeed.config != null && configSeed.config.watch && configSeed.config.watch.interval) {
      interval = configSeed.config.watch.interval
    }

    watcher = chokidar.watch(configSeed.configPath, {
      interval,
      usePolling: true,
      persistent: true,
      ignoreInitial: true,
    })

    watcher
      .on('add', () => async () => {
        console.log('🔃 detect config file add, server start...')

        if (server != null) {
          await server.close()
          server = null
        }

        configSeed = configLoad()

        if (configSeed.config != null) {
          server = await init(configSeed.config)
        }
      })
      .on('change', async () => {
        console.log('🔃 detect config file change, server restart...')

        if (server != null) {
          await server.close()
          server = null
        }
        configSeed = configLoad()

        if (configSeed.config != null) {
          server = await init(configSeed.config)
        }
      })
      .on('unlink', async () => {
        console.log('🔃 detect config file removed, server close...')
        if (server != null) {
          await server.close()
          server = null
        }
      })
  }

  if (configSeed.config != null) {
    server = await init(configSeed.config)
  }

  process.on('SIGTERM', async () => {
    if (watcher != null) {
      await watcher.close()
    }
    if (server != null) {
      await server.close()
      server = null
    }
  })
}

console.log(logo)
console.log('version:', env.version, '\n')

if (process.argv[2] === '--install') {
  install.install(process.argv[3] === '--force')
} else if (process.argv[2] === '--uninstall') {
  uninstall.uninstall()
} else if (process.argv[2] === '--help') {
  help.help()
} else if (process.argv[2] === '--run') {
  run.run(true)
} else {
  main()
}
