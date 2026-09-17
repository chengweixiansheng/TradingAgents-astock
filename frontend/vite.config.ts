import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// 后端接口走 /api 前缀，默认代理到本地 FastAPI。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // 写死 127.0.0.1：写 localhost 会解析成 IPv6 ::1，而后端只监听 IPv4，
  // /api 代理会 ECONNREFUSED。全部 /api 走同一个目标。
  const agentTarget = env.VITE_AGENT_URL || env.VITE_API_URL || "http://127.0.0.1:8910";

  return {
    plugins: [react()],
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
    server: {
      port: 5910,
      proxy: {
        // 全部 /api → 本仓库后端（8910）。见上面注释：不再需要逐条列举。
        "/api": { target: agentTarget, changeOrigin: true },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            "vendor-react": ["react", "react-dom", "react-router-dom"],
            "vendor-charts": ["echarts"],
          },
        },
      },
    },
  };
});
