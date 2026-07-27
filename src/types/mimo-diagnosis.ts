import type { LogSource } from './console';

/**
 * 传给业务上下文提供器的已脱敏错误摘要。
 * 不暴露原始 Network 请求头、请求体或浏览器存储，避免业务方误把敏感数据带入诊断请求。
 */
export interface MimoDiagnosisErrorContext {
  id: number;
  name?: string;
  message: string;
  stack?: string;
  timestamp: number;
  source?: LogSource;
}

/** 当前页面中与错误定位有关的运行时信息。 */
export interface MimoDiagnosisRuntimeContext {
  origin: string;
  pathname: string;
  title: string;
}

/**
 * 业务侧补充上下文的输入。
 * 返回值会在发送前再次做长度限制和敏感字段脱敏。
 */
export interface MimoDiagnosisContextProviderInput {
  error: MimoDiagnosisErrorContext;
  runtime: MimoDiagnosisRuntimeContext;
}

/** 业务侧可补充的、可序列化的诊断上下文。 */
export type MimoDiagnosisContext = Record<string, unknown>;

/** 小米 AI 诊断配置。 */
export interface MimoAIDiagnosisOptions {
  /** 默认 false；关闭时不注册 AI 诊断 Tab，也不会采集或发送额外数据。 */
  enabled?: boolean;
  /**
   * 补充当前业务场景，例如功能标识、发布版本或已脱敏的实体标识。
   * 请勿返回 token、Cookie、用户输入全文或完整 store。
   */
  contextProvider?: (
    input: MimoDiagnosisContextProviderInput,
  ) => MimoDiagnosisContext | Promise<MimoDiagnosisContext>;
}
