/**
 * CDN 单文件入口：默认导出构造函数，使经典 script 标签可直接使用 new Nconsole()。
 */
import Nconsole, {
  createMimoAIDiagnosisPlugin,
  createPerformancePlugin,
  createSourcePlugin,
} from './index';

/** 将内置插件工厂挂到构造函数，保持 CDN 使用时无需额外全局变量。 */
Object.assign(Nconsole, {
  createMimoAIDiagnosisPlugin,
  createPerformancePlugin,
  createSourcePlugin,
});

export default Nconsole;
