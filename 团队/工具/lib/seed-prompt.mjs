// 角色开局提示词唯一实现（R-20261119 Owner 实测）：
// 建团队时给空白会话发的「就位」消息不能只让人回一句已就位——必须先读规则与本人目录文件，
// 否则角色不知道自己的运转流程与职责，只会被程序戳一下动一下。
// 抽成 lib 便于夹具直接断言（launch.mjs 只做调用）。
import { ROLE_NAMES } from './store.mjs';
import { TEAM_MODE_LABELS, ROLE_DIRS, teamModeDescription } from './roles.mjs';

function waitLine(role, name) {
  return role === 'pm'
    ? '只回一行：“PM 已就位，请老板说项目需求和场景。”'
    : `只回一行：“${name} 已就位，等待 PM 派单。”`;
}

function fastDuty(role, teamMode) {
  if (teamMode !== 'fast') return '';
  if (role === 'analyst') return '快速模式：需求评审由你执行（req review）；需要驳回 Owner 需求时可用 vote start 按实际分析师身份发起；技术评审记录由程序员A执行；投票用 vote cast。';
  if (role === 'programmer1') return '快速模式：技术评审记录由你执行（req review --kind tech）；投票用 vote cast。';
  if (role === 'tester') return '快速模式：投票用 vote cast；除 PM 外全员一致驳回才驳回，只按证据投票。';
  if (role === 'pm') return '快速模式：需求评审交需求分析师，技术评审记录交程序员A；组织投票用 vote start / vote status，PM 不投票。';
  return '';
}

export function startupText(role, project, workspace, teamMode = 'full') {
  const name = ROLE_NAMES[role] || role;
  const dir = ROLE_DIRS[role] || name;
  return `你是「${name}」（${role}），工作区 ${workspace}。\n`
    + `团队模式：${TEAM_MODE_LABELS[teamMode]}（${teamModeDescription(teamMode)}）。${fastDuty(role, teamMode)}\n`
    + '全程中文思考、中文回复、中文写文档。每轮第一件事读《团队宪法》（唯一最高优先级；项目铁律按需避坑）；本回合只做三件事，不分析、不计划、不总结：\n'
    + `1) 运行 node 团队\\工具\\team.mjs boot --role ${role} --project "${project}"\n`
    + `2) 按简报读完必读文件，并读你名下目录「项目\\${project}\\${dir}\\」里的 角色卡.md、交接-最新.md（若有）与 产出\\ 索引，弄清职责/流程/在途\n`
    + `3) ${waitLine(role, name)}\n`
    + '不要建任务、不要写文件、不要输出方案。等老板/PM 下一条明确指令。';
}

export function seedTextFor(role, name, project) {
  const display = name || ROLE_NAMES[role] || role;
  const dir = ROLE_DIRS[role] || display;
  return `你是「${display}」（${role}），项目「${project}」。先按顺序做完下面 4 步，再回复：\n`
    + '1) 读规则：《团队宪法》（团队\\团队宪法.md）、《流程.md》第二部分（现行工作流基线）、《项目铁律》（项目\\' + project + '\\项目铁律.md）；\n'
    + `2) 运行 node 团队\\工具\\team.mjs boot --role ${role} --project "${project}" 拿启动令牌，并按简报把必读文件全部读完（团队宪法/项目铁律/项目信息/项目索引/角色卡/协作准则/需求总览）；\n`
    + `3) 读你自己名下目录「项目\\${project}\\${dir}\\」：角色卡.md、交接-最新.md（若有）、产出\\ 的索引与最近产出，弄清自己的职责、流程与在途；\n`
    + `4) ${waitLine(role, display)}（附 boot 令牌前 8 位 + 已读文件数）。\n`
    + '读之前不要分析、不要写文件、不要建任务；这 4 步做完只回一行。';
}

export default { startupText, seedTextFor };
