# 架构（v0.1）

## 分层

```text
renderer/
  纯 DOM 界面：项目、看板、流程图、Owner 决策
preload.js
  最小 IPC 桥，不向页面暴露 Node
main.js
  本地项目库 / 任务 / 流程状态 / 系统窗口
dsh-adapter.js
  DSH 外部引擎适配层：认证、session/list、session/create、session/rename、
  session/prompt、workspace/create、archiveSession；不复制 DSH 源码
```

## 数据

本地状态由主进程写入 Electron `userData/workbench.json`：

```text
projects[]:
  id, name, path, tasks[], ownerReview, events[]
```

项目目录由本应用创建：

```text
项目/
  项目经理/
  产品/
  需求分析师/
  程序员A/
  程序员B/
  测试人员/
  src/        # 程序员代码
  _tmp/       # 临时文件，交付前清理
  需求/
  项目信息.md
```

## 流程状态

```text
intake -> requirement -> review -> owner -> dispatch -> dev -> test -> close
```

- 无任务：`intake`
- 有任务、Owner 未决定：`owner`
- Owner 打回：`requirement`
- 有测试任务未完成：`test`
- 有开发任务未完成：`dev`
- Owner 通过/跳过后：`dispatch`
- 全部任务完成：`close`

## 下一步

- 接入 DSH 会话创建与事件适配
- 项目文件索引
- 提案/评审/签字
- 角色回执与单人派单锁
