// 「装进 profile 之后还能不能用」：从一次性 profile 的 node_modules 里按包名导入，
// 用假 ctx 走一遍注册面。证明 exports 映射、ESM 入口、技能正文内联、工具定义都成立。
//
// 用法：node test/e2e-installed.mjs <profile-dir>
import { pathToFileURL } from 'node:url'

const profileDir = process.argv[2]
if (!profileDir) {
  console.error('用法：node test/e2e-installed.mjs <profile-dir>')
  process.exit(2)
}

// 按包名解析：把解析根指向 profile 目录（node_modules 就在它下面）。
const resolveFrom = pathToFileURL(`${profileDir}/package.json`).href
const { createRequire } = await import('node:module')
const requireFromProfile = createRequire(resolveFrom)

const entry = requireFromProfile.resolve('dsh-env-doctor')
const toolsEntry = requireFromProfile.resolve('dsh-env-doctor/tools')
const skillsEntry = requireFromProfile.resolve('dsh-env-doctor/cordis.patch.yml')

const plugin = await import(pathToFileURL(entry).href)
const tools = await import(pathToFileURL(toolsEntry).href)

let failures = 0
function check(label, passed) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}`)
  if (!passed) failures += 1
}

check('包能按名字解析到入口', entry.endsWith('lib\\index.js') || entry.endsWith('lib/index.js'))
check('bundle patch 也在包里（cordis.patch.yml）', skillsEntry.endsWith('cordis.patch.yml'))
check('inject 声明了 skills', Array.isArray(plugin.inject) && plugin.inject.includes('skills'))

let skill
plugin.apply({
  skills: {
    register(definition) {
      skill = definition
      return () => {}
    },
  },
  get() {
    return undefined
  },
})
check('技能已注册', skill?.name === 'dsh-env-doctor')
check('技能正文不是空的', typeof skill?.content === 'string' && skill.content.length > 500)
check('技能正文没有 frontmatter', !skill?.content?.startsWith('---'))

let definition
tools.apply({
  tools: {
    register(candidate) {
      definition = candidate
      return () => {}
    },
    guard() {
      return () => {}
    },
  },
  get() {
    return undefined
  },
})
check('工具已注册且名字正确', definition?.name === 'dsh_env_doctor')
check('工具参数是 object 顶层', definition?.parameters?.type === 'object')
check('工具带 output.schema 与 render', Boolean(definition?.output?.schema) && typeof definition?.output?.render === 'function')

console.log(failures === 0 ? '装进 profile 后可用：OK' : `装进 profile 后有问题：${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
