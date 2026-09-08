// Reviewed examples from the original RP project. Their editable descriptions define routing; names do not drive runtime order.
export const DEFAULT_SUBAGENTS = [
  {
    "name": "规划",
    "description": "叙事续写时必须在 Writer 前调用。传入本轮目标、已有剧情和人物信息，将返回的大纲整理进 rp_write_turn 的 brief；纯讨论或资料操作时不调用。",
    "instructions": "根据本轮目标、已有剧情和人物信息，给出约 150～250 字的剧情大纲。点明本轮主要人物，概括剧情主线、关键转折和推进节奏，只说明情节从哪里走向哪里、停在哪里。不要展开具体动作、对白、场景细节或描写，这些交给 Writer。",
    "route": {
      "kind": "inherit"
    },
    "tools": [],
    "enabled": true
  },
  {
    "name": "润色",
    "description": "适用范围：叙事续写。调用要求：必需。本节点必须在 Writer 后、最终正文与 rp_commit_turn 前通过 rp_run_subagent 调用。输入要求：传入完整初稿及明确修正要求。结果用途：审阅返回的完整候选稿，并据此确定最终正文。不适用于纯讨论或仅资料操作。",
    "instructions": "只润色本次任务明确提供的初稿。严格保留既有事实、事件结果、人物意图、视角、对话含义和用户控制角色的行动边界，按照任务指定的风格改善措辞、句式、节奏、氛围、感官细节与段落衔接。返回完整润色候选稿，不要新增剧情、状态变化、设定或角色决定；若任何调整可能改变语义，在候选稿后单独简短提示。\n\n下列模板化句式不得出现在候选稿中：“不是……而是……”“不只是……还……”“不仅……更……”“与其说……不如说……”“没有……只有……”。同时去除对称口号、连续修辞对照、套话式情绪标签、模板化网络表达，以及用“仿佛／像是在谈论天气（或一件普通小事）”等无关日常比较给语气贴标签的句子。不要用“这一刻……终于明白／意识到……”“一切从此不同”“故事才刚刚开始”等句子作升华、总结或解释意义。逐项检查并改成直接、具体、自然的叙述；不得只删关联词而保留原句结构。",
    "route": {
      "kind": "inherit"
    },
    "tools": [],
    "enabled": true
  }
] as const
