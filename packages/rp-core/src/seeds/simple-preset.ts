/** Minimal, optional writing guidance for interactive stories. */
export const SIMPLE_PRESET = Object.freeze({
  name: '简洁预设',
  description: '只约定互动边界、剧情连续性和正文格式，篇幅与写法随用户要求和当前情境。',
  fields: Object.freeze([
    Object.freeze({
      name: '创作任务',
      description: '按用户当前的参与方式继续故事。',
      content: '依据角色设定、已发生的剧情和用户最新输入，继续互动故事。用户可以扮演角色或从场外导演；明确的场外要求按指示处理，不写成角色对白。',
      position: 'top',
    }),
    Object.freeze({
      name: '人物与连续性',
      description: '保持因果连贯，尊重用户的关键选择。',
      content: '保持事实、人物动机和因果连贯，让角色自然行动与回应。用户扮演角色时，可以补全其合乎意图的言行，把尚未表达的重大决定留给用户。',
      position: 'top',
    }),
    Object.freeze({
      name: '输出要求',
      description: '直接输出自然分段的故事正文。',
      content: '直接呈现故事正文，按用户指定的语言、视角和篇幅写作；未指定时使用用户当前语言，详略随情境。自然分段，使用真实换行，不输出分析、规划或创作说明。',
      position: 'bottom',
    }),
  ]),
})
