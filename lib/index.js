// dsh-env-doctor 主行（bundle 入口）：把「怎么用」写成一条技能，进程内注册。
//
// 三条实测教训（dsh-hello 实证，2026-10-14）：
//   a) 直接读 `ctx.skills` 会抛 `cannot get property "skills" without inject`；写成 `ctx?.skills` 也拦不住。
//      必须先 `export const inject = ['skills']`，Cordis 才会等服务就绪再调 apply。
//   b) `ctx.get('skills')` 不会抛也不会等 —— 服务没挂上时返回 undefined，注册会被静默跳过。
//   c) 任何 @deepseek-ai/* 依赖都会拉进第二份拷贝、身份与宿主不同，工具调用会崩在
//      `Cannot read properties of undefined (reading 'prepare')`。本包零依赖，只用 node: 内建。
import { readFileSync } from 'node:fs'

export const name = 'dsh-env-doctor'

export const inject = ['skills']

const SKILL_URL = new URL('../bundled-skills/env-doctor/SKILL.md', import.meta.url)

/** 读 SKILL.md 并剥掉 YAML frontmatter：register() 要的是纯 Markdown 正文。 */
function readSkillBody() {
  const raw = readFileSync(SKILL_URL, 'utf8')
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

export function apply(ctx) {
  const content = readSkillBody()

  // 运行时技能：同一层里项目条目优先于 runtime，runtime 优先于用户目录。
  ctx.skills.register({
    name: 'dsh-env-doctor',
    description:
      'Windows 上的 DSH 环境体检：用户说「体检一下」「环境是不是坏了」「为什么写入被拒 / bash 起不来 / npm 脚本被拦」时用。只读探测，给出结论 + 下一步命令，可修项需两道确认。',
    whenToUse:
      '用户抱怨 DSH/Windows 环境异常（沙箱拒写、ACL、Git Bash 启动失败、网络或镜像、执行策略挡 .ps1、工具链版本混乱、安装通道不可用），或想在做别的事之前先确认环境健康。',
    source: 'bundled',
    content,
  })
}
