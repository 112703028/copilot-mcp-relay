// relay 端限制使用者的 task; poller 端收到的是「指示模板 + task」, 所以上限要預留模板的空間。
// 兩端共用這裡的常數, 避免 relay 放行、poller 卻拒絕。
export const MAX_TASK_LENGTH = 4000;
export const PROMPT_TEMPLATE_ALLOWANCE = 1000;
export const MAX_PROMPT_LENGTH = MAX_TASK_LENGTH + PROMPT_TEMPLATE_ALLOWANCE;
