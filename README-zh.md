# dsh-batch-triage

**规则判掉简单的工单。规则判不了的一律交给人 —— 永远不会被悄悄记成 routine。**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。
**不调模型、不连服务、不联网、不需要 API key。**

```
$ node -e "
  import('dsh-batch-triage').then(m => {
    const r = m.triageBatch([
      { id: 'a', text: 'The service is down for all users' },
      { id: 'b', text: 'How do I install this on Windows?' },
      { id: 'c', text: 'The frobnitz is blorp.' },
    ], m.resolveConfig({}));
    console.log(r.items.map(i => i.id + ' ' + i.class + '  ' + i.reasonCodes[0]).join('\n'));
    console.log('exit', r.exitCode, r.exitBasis);
  })"

a urgent        OUTAGE_REPORTED
b routine       INSTALL_QUESTION
c needs_review  NO_RULE_MATCHED
exit 6 modelUnavailable
```

## 为什么规则在先

一个工单批次不适合「一条一次模型调用」：量大、有意思的少，
而且**不管需不需要，每条都要一个来回**。所以顺序被反过来写。

**prefilter 先覆盖每一条。** 规则判掉清楚的 —— 带栈回溯的崩溃是 urgent，
「怎么装」是 routine —— 而且**不询问任何东西**就判掉。
只有残差才可能进模型，而本版**根本不进**：它如实说明。

这不是优化，是设计的主路径，也改变了这个工具是什么：
**prefilter 是产品，模型是给残差用的备胎。**

## 最重要的那条规则

> **一条 item 只有在规则说了的情况下才是 `routine`。**

四条「判不了」的路径 —— 正文为空、没有规则命中、没配模型、预算耗尽 ——
**全部**产出 `needs_review`。把「我判不了」变成「没什么可看的」，
是这个工具存在的唯一理由所要防的事，测试在两个方向都钉住了它。

`decidedBy` 说明实际是哪一层判的：

| 值 | 含义 |
|---|---|
| `prefilter` | 规则判的；`reasonCodes` 指明是哪条 |
| `unavailable` | 没有规则能判，且本次会话没配模型层 |
| `budget` | 触到上限，所以这条**没有被评估** |

后两者都带 `escalate: true`。它们都不是对工单的判断，而是对「这次运行能做什么」的陈述。

## 规则看什么

**结构化字段强于正文**：`severity: critical`、`security: true`、`data_loss: true`、
`reporter_tier: enterprise`。填过表的人已经告诉你了，正文里的一句话不该能推翻它。

否则**首个命中的文本规则生效**，顺序是有文档的：

| 类别 | 规则 |
|---|---|
| `urgent` | `outage`、`data_loss`、`security`、`crash_with_trace`、`blocked_workflow` |
| `needs_review` | `regression`、`wrong_result`、`performance`、`flaky` |
| `routine` | `install_question`、`usage_question`、`documentation`、`feature_request`、`thanks` |

urgent 规则排在最前是有意的：一个既报告故障、又写成疑问句的工单，
不能被疑问句规则吞掉 —— 这条有测试。

选「首个命中」而不是「最具体者胜」是刻意的。打分制需要一套没人能辩护的权重；
**一个有文档的顺序是可检查的**，而一条永不命中的规则是一个**看得见的** bug。

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 跑完，没有东西需要人看 |
| `1` | 跑完并**有发现** —— 不是失败 |
| `2` | 调用非法（空批次、超上限、id 重复） |
| `3` | 配置无法满足 |
| `4` | 空扫描 |
| `5` | 记录的期望未满足 |
| `6` | 所有需要模型的条目都被跳过 |
| `7` | 有上限在任何条目进模型之前就是 0 |

优先级是 `lib/exit.mjs` 里**唯一一处**的阶梯，因为一次运行可能同时满足多个条件：

```
2 用法 → 3 配置 → 4 空扫描 → 7 零预算 →
6 模型不可用 → 5 断言失败 → 1 有发现 → 0 干净
```

其中两条是判断，值得写下来：

* **用法错误高于一切。** 一次从未合法的运行不可能发现了任何东西。
* **覆盖缺口高于发现。** `6` 说的是「这次运行没能覆盖它需要覆盖的全部」，
  比 `1` 的「其中一部分要人看」更强，而且是**超集**。

第二条的隐患是只看退出码的调用者会以为批次没问题。所以 summary **永远**列出
`urgentIds` 与 `escalatedIds`，并有测试断言：覆盖缺口存在时，urgent 条目仍在 summary 里。

**CI 约定**：`{0, 1, 6}` 都是成功运行，导出为 `CI_ACCEPTED`。
把 `1` 当失败的 job，会在**每一个值得跑的批次**上变红。

## 上限是决定，不是静默丢弃

预算负担不起的条目是 `needs_review` + `BUDGET_EXHAUSTED`，
summary 计入 `budgetRefusals`。**被截断的运行不能读起来像完整的运行。**

`modelStateCap: 0` 在**加载时就被拒绝**，不是被接受 ——
它同一次调用里既要求模型覆盖又禁止它。

## 上限与校验

一次 1–64 条。超过就**拒绝，而不是截断** —— 被截断的批次报告的是
「先到的那几条的摘要」，而它读起来和整批的摘要一模一样。
`id` 重复被拒绝而不是合并：id 是答案的键，合并会丢工单且无法分辨是哪条。

## `tau` 在这里能做什么、不能做什么

`tau` 是置信度上的升级阈值，而本版没有置信度可比。
所以它只做设计允许的那一件事：让 `needs_review` 的条目升级，**永不降级**。
一个被接受却毫无效果的选项，比一个被拒绝的选项更糟 —— 调用者会以为检查过了。

## 本版**没有**的东西

**模型层。** 输出已经带着它会填的字段（`modelClass`、`confidence`、
`top2Margin`、`score`），而 `modelClass` 报 `unavailable`，因为那是事实。

不做的理由是这个家族到处都在用的那条：确定性层才是实测价值的所在，
而一个要加模型调用的层需要的是**一次测量，而不是一个假设**。
把字段如实报成 `unavailable`，比发一个没人量过的层更诚实。

同样不在本版：`policyId`（从文件读的命名策略）与 `tokenCap` 的强制执行
（需要模型回报 `input_tokens`）。两者没有模型层都是空转。

## 测试

```sh
npm test                  # 37 条断言，不需要主机
npm run verify:artifacts   # 检查 npm publish 真正会发出去的东西
```

自检**不只查结构，还查行为**：它跑真实的 prefilter，并断言规则表里
**每一条规则仍然能命中**。一条无法命中的规则，和一条什么都没找到的规则，
长得一模一样 —— 而这个失败形态在本项目家族里已经发布过两次。
