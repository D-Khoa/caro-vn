/**
 * Bộ khởi chạy đa nhân (Cluster Mode) giúp mở rộng quy mô ngang trên toàn bộ CPU Cores
 * Đáp ứng thoải mái > 10,000 người chơi đồng thời.
 */
import cluster from 'node:cluster';
import os from 'node:os';

if (cluster.isPrimary) {
  const numCPUs = Math.min(os.cpus().length, 8);
  console.log(`[Cluster Master] Khởi tạo ${numCPUs} Worker Processes cho Cờ Caro Vở Ô Ly VN...`);
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker) => {
    console.log(`[Cluster Master] Worker ${worker.process.pid} dừng, đang khởi động lại...`);
    cluster.fork();
  });
} else {
  await import('./index.js');
}
