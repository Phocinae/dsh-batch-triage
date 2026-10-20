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

0.1.2 收紧了「规则说了」这句话的适用范围。规则锚定的是一个**短语**，而一张工单
不止一句话：当命中的短语是个疑问句、而同一张工单的另一句话在报告故障时，
疑问句规则没有资格判掉整张工单。它会变成 `needs_review` + `MALFUNCTION_REPORTED`，
而那条本来会吞掉它的规则仍留在 `reasonCodes` 里，两半都看得见。

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

否则**取所有规则中类别最高的那一条**；表按类别从强到弱排列，
所以同一类别内平手时，靠前的那条规则胜出：

| 类别 | 规则 |
|---|---|
| `urgent` | `outage`、`data_loss`、`security`、`crash_with_trace`、`blocked_workflow` |
| `needs_review` | `regression`、`wrong_result`、`performance`、`flaky` |
| `routine` | `install_question`、`usage_question`、`documentation`、`feature_request`、`thanks` |

一个既报告故障、又写成疑问句的工单，不能被疑问句规则吞掉 —— 这条有测试。
但在 0.1.1 里，那是一条**不可能失败**的测试：它的样本用的是 `outage` 规则本来就认得的措辞，
样本和规则共享了同一个假设，真正的优先级从没被检验过。现在优先级按**类别**而不是按**位置**，
所以无论表怎么排 —— 包括调用方通过 `rules` 传入的表 —— 疑问句规则都无法判掉一条 urgent 规则也命中的工单。

只有类别优先级还不够，下面那六条实测工单就是证明：`outage` 不认
「returns 500 for every request」，于是**没有任何**严重性规则命中，
疑问句规则只凭其中一句话就判了整张工单。所以 `routine` 结论还要再过一道检查：
如果正文报告了故障 —— 报错、崩溃、「unusable」、5xx、记录被删、凭据泄露 ——
而措辞是没有任何严重性规则能命名的，这条 item 就变成
`needs_review` + `MALFUNCTION_REPORTED`，而不是 `routine`。
这道守卫只会**拒绝** `routine`；它不能把任何东西升成 `urgent`，
也不会碰严重性规则已经做出的判断。

选「类别优先级」而不是「最具体者胜」是刻意的。打分制需要一套没人能辩护的权重；
类别阶梯不需要，而规则表依然可检查 —— 一条永不命中的规则是一个**看得见的** bug。

修复所依据的六条措辞，逐字来自那次审计。在 0.1.1 上六条**全部**是 `routine`、退出码 **0**：

| 工单 | 0.1.1 | 0.1.2 |
|---|---|---|
| `How do I install this? Also our production API returns 500 for every request.` | `routine` `INSTALL_QUESTION`，退出 0 | `urgent` `OUTAGE_REPORTED`，退出 1 |
| `Is there documentation for the auth flow? We are seeing records deleted from our database.` | `routine` `DOCUMENTATION_REQUEST`，退出 0 | `urgent` `DATA_LOSS_REPORTED`，退出 1 |
| `Feature request: please add CSV export. Meanwhile the app is unusable for our whole team.` | `routine` `FEATURE_REQUEST`，退出 0 | `urgent` `OUTAGE_REPORTED`，退出 1 |
| `How do I configure SSRF protection? Our pentest found we can read other users files.` | `routine` `INSTALL_QUESTION`，退出 0 | `urgent` `SECURITY_REPORTED`，退出 1 |
| `where can i find the logs? the service has been returning 503 all morning` | `routine` `INSTALL_QUESTION`，退出 0 | `urgent` `OUTAGE_REPORTED`，退出 1 |
| `What is the right way to rotate keys? Our API token leaked in a public repo.` | `routine` `USAGE_QUESTION`，退出 0 | `urgent` `SECURITY_REPORTED`，退出 1 |

**只**是提问的工单不受影响：`How do I install this on Windows?` 仍然是 `routine`，
一批全是 routine 的批次仍然退出 0。这道守卫是地板，不是往紧急方向偏。

**这道守卫的代价，写在这里而不是等你自己发现**：它刻意保守，所以**提到**故障词的提问
也会被抬高 —— `How do I handle errors returned by the parser?` 会是 `needs_review`
而不是 `routine`。类别变了，退出码没变：本版里 prefilter 判出的 `needs_review`
不构成 finding。这是一个**真实存在的遗留缺口** —— 守卫自己判出的条目仍然退出 0，
所以上面六条必须凭自身理由落到 `urgent`，而不是仅仅停在 `needs_review`。
这一点写在 CHANGELOG 里，而不是留给读者去发现。

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 跑完，没有东西需要人看 |
| `1` | 跑完并**有发现** —— 不是失败 |
| `2` | 调用非法（空批次、超上限、条目结构不合法） |
| `3` | 输入或策略无法满足（`id` 重复） |
| `4` | 空扫描 |
| `5` | 记录的期望未满足 |
| `6` | 所有需要模型的条目都被跳过 |
| `7` | 有上限在任何条目进模型之前就是 0 |

优先级是 `lib/exit.mjs` 里**唯一一处**的阶梯，因为一次运行可能同时满足多个条件：

```
2 用法 → 3 配置 → 4 空扫描 → 7 零预算 →
6 模型不可用 → 5 断言失败 → 1 有发现 → 0 干净
```

一次 1–64 条的批次只可能落到 `0`、`1`、`2`、`3`、`6`。另外三档阶梯在本批次运行器里
**没有生产者**：

* **`4` 空扫描** 被 `2` 抢先：空批次在任何条目被扫描之前就按用法错误拒绝了，
  所以 `emptyScan` 在这里永远不会为真。第 4 档是留给直接驱动 `exitCode()` 的调用者的。
* **`5` 断言失败** 完全没有生产者 —— 本版没有 `expect` API。这一档是保留并写明的，
  而不是凭空发明的。
* **`7` 零预算** 在加载时就被拒绝，因为 `modelStateCap: 0` 是配置错误（见下）。
  `7` 只能通过 `exitCode()` 本身，或通过一个从未经过 `resolveConfig` 的配置对象到达。

把这份阶梯读成「你会看到的就是这些码」是错的；它是完整的**优先级顺序**，
不是可观测码的完整清单。

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
它同一次调用里既要求模型覆盖又禁止它。拒绝以 `TRIAGE_BAD_CONFIG` + exit `2` 报出，
不是 `3`：一个自相矛盾的请求被阶梯归为**非法调用**，而不是读不进来的输入。
没有任何条目到达模型，所以第 `7` 档永远走不到 —— 见退出码表下方的说明。

## 上限与校验

一次 1–64 条，其中 64 是默认的 `maxItems` 上限，而不是它唯一能取的值：
运维把 `maxItems` 调高，批次上限就跟着调高，prefilter 的开销对批次大小是线性的。
超过就**拒绝，而不是截断** —— 被截断的批次报告的是
「先到的那几条的摘要」，而它读起来和整批的摘要一模一样。
`id` 重复被拒绝而不是合并：id 是答案的键，合并会丢工单且无法分辨是哪条。
这个拒绝是 exit `3` 而不是 `2`：批次本身是良构的，无法满足的是 id 到答案的映射。

## `failOn` 做什么

`failOn` 决定哪些类算「有发现」（exit `1`）：

| 取值 | 什么算有发现 |
|---|---|
| `any`（默认） | urgent、任何升级、**或任何 `needs_review`** |
| `urgent` | 只有 urgent |
| `none` | 都不算 —— 调用者要的是报告，不是闸门 |

`needs_review` 就是「需要人看」，无论它来自 prefilter 规则（`regression`、
`wrong_result`、`performance`、`flaky`、字段 `severity: high|medium`）还是残差
（没有规则命中、模型不可用、预算耗尽）。0.1.3 之前只算残差，所以一张回归单
即使已经被规则判成 `needs_review`，整批仍是 `0 clean` —— 这个缺口已关闭：
`any` 下，规则判出的 `needs_review` 也是 finding。

退出码仍然优先于 finding：没有模型客户端时，残差条目会先停在 `6`
（`modelUnavailable`）；用法/配置错误又压在两者之上。所以随包发布的插件有两种可见情形：

| 批次 | `failOn` 的效果 |
|---|---|
| 含残差条目（没有规则命中） | 无论 `failOn` 取值都 exit `6` |
| 所有条目都已被判定，其中至少一条 `needs_review` | `any` → `1`；`urgent` / `none` → `0` |

`modelClient` 是库层选项，故意不放进下面的 YAML 配置块：它是给测试和
「以程序方式提供客户端」的宿主用的接缝。本版仍然从不调用这个客户端 ——
`modelClass` 保持 `unavailable`。

### 从 0.1.2 迁移

如果某个 CI 任务依赖 `failOn: any` 在“唯一问题是规则判出的 `needs_review`”
（`regression`、`wrong_result`、`performance`、`flaky`、`severity: high|medium`）
时返回 `0`，现在它会返回 `1`。

请选择你真正想要的策略：

- `failOn: urgent` —— 只有 urgent 会失败。它**不是**旧行为的精确恢复：
  它也会忽略残差升级，而旧的 `any` 会算这些。
- `failOn: none` —— 只要报告，不做闸门。

这个变化是有意的：规则已经说“需要人看”的批次，不应该给出绿色结果。
`failOn: any` 仍是默认值。

## `tau` 在这里能做什么、不能做什么

`tau` 是置信度上的升级阈值，而本版没有置信度可比。
所以它只做设计允许的那一件事：让 `needs_review` 的条目升级，**永不降级**。
一个被接受却毫无效果的选项，比一个被拒绝的选项更糟 —— 调用者会以为检查过了。

## 本版**无效**的选项

有四个被接受的键在没有模型层时完全没有效果。它们放在一起说明，
因为「静默接受」正是这个项目在别处批评过的做法。

| 键 | 状态 |
|---|---|
| `policyId` | 接受，但不加载任何策略文件 |
| `tokenCap` | 接受，但没有任何东西回报 `input_tokens` 供它执行 |
| `timeoutMs` | 接受，但没有任何子进程会被超时约束 |
| `batchSize` | 接受，但没有任何东西会被成批发出去 |

它们**仍然做范围校验**，所以 `timeoutMs: 0` 会在加载时被拒。
这是刻意的，不是顺手为之：校验那部分在模型层落地后仍然是对的，
现在删掉只会意味着以后在压力下补回来。

`failOn` 是特例，值得单独一句：它**在出厂路径上也生效**。所有条目都已被判定、
其中至少一条是 `needs_review` 时，`any` 下 exit `1`，`urgent` / `none` 下 exit `0`。
只有残差条目（没有规则能命中、又没有模型客户端）会以 `6` 压过有发现那一档。

## 规则遇到不认识的 severity 会怎样

不认识的 `severity` —— `P4`、`banana`、`kritisch` —— **不会**被当成没填。
丢掉它，就是**一个真实的优先级悄悄变成 routine** 的路径；
把它抬成 urgent 又是凭空造信号。所以它变成 `needs_review` +
`FIELD_SEVERITY_UNRECOGNISED`：字段说了关于优先级的事，而本版不知道是什么 ——
这是一个问题，不是一次猜测。

认识的词表刻意宽（顶层含 `critical`、`blocker`、`sev1`、`s1`、`P0`、
`urgent`、`emergency`、`showstopper`、`severity 1`、`1`、`highest`），
因为 0.1.0 只认四个标签，于是 `severity: 'P0'` 的行为和「没填 severity」一模一样。

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
npm test                  # 45 个测试用例，不需要主机
npm run verify:artifacts   # 检查 npm publish 真正会发出去的东西
```

两者都在发布路径上：`prepack` 是 `npm test && npm run verify:artifacts`，
所以一条不再命中的规则发不出去。0.1.2 之前它发得出去 ——
`verify:artifacts` 为每条规则都带了一个正向样本、红了就会失败，
但没有任何环节在出门前跑它。

`node --test` 报的是**测试用例**数，不是断言数：本套件 45 个用例里约有 170 处
`assert` 调用，很多在循环里。这个区别在用例带循环时是重要的 ——
一个用例在五次迭代的第三次上失败，仍然只算一个失败，而用例数不会告诉你失败的是哪一次。

自检**不只查结构，还查行为**：它跑真实的 prefilter，并断言规则表里
**每一条规则仍然能命中**。一条无法命中的规则，和一条什么都没找到的规则，
长得一模一样 —— 而这个失败形态在本项目家族里已经发布过两次。
