// 从任务推导「官方无 ACAO 地址」: 浏览器内这些地址只能经 CORS 网关取
// 用于失败后「从网关重试」: 计划阶段没配网关时官方候选已被剔除, 这里按任务自身字段重建
export function officialUrlsFor(task) {
  const sha1 = task?.sha1 || '';
  switch (task?.category) {
    case 'asset':
      return sha1 ? [`https://resources.download.minecraft.net/${sha1.slice(0, 2)}/${sha1}`] : [];
    case 'library': {
      const rel = String(task.path || '').replace(/^libraries\//, '');
      return rel ? [`https://libraries.minecraft.net/${rel}`] : [];
    }
    case 'logConfig': {
      const name = String(task.path || '').split('/').pop();
      return sha1 && name ? [`https://launcher.mojang.com/v1/objects/${sha1}/${name}`] : [];
    }
    case 'jar':
      return sha1 ? [`https://piston-data.mojang.com/v1/objects/${sha1}/client.jar`] : [];
    default:
      return [];
  }
}
