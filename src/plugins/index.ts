/** 内置插件的统一导出入口，避免使用方依赖具体实现文件。 */
export { createSourcePlugin } from './source-plugin';
export { createPerformancePlugin } from './performance-plugin';
export { createMimoAIDiagnosisPlugin } from './mimo-ai-diagnosis-plugin';
