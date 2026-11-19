// 设备与诊断 API 尚未交付时的本地示例。不接触本机日志或真实设备。
export function deviceFixture() {
  const device={id:'dev_example',name:'示例工作站',online:true,edge_version:'0.1-demo',os:'darwin',arch:'arm64',last_seen_at:new Date().toISOString(),revision:1,actions:['read','diag']}
  const jobs=new Map()
  return {
    async get(path,{params={}}={}) {
      if(path==='/devices'){
        const items=device.name.includes(params.q||'')?[device]:[]
        return {items,total:items.length,next_cursor:null}
      }
      if(path==='/devices/'+device.id)return device
      const job=jobs.get(path)
      if(!job) throw Error('没有此诊断任务')
      return Date.now()-job>600 ? {status:'completed',download_url:'./mock/sample-log.txt'} : {status:'running'}
    },
    async post(path,body) {
      if(path!=='/devices/'+device.id+'/diag'||body.kind!=='logs') throw Error('不支持的示例操作')
      const diag_id=crypto.randomUUID();jobs.set('/diag/'+diag_id,Date.now());return {diag_id}
    }
  }
}
