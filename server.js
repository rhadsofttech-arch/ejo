// Tiny server for hosts that run `npm start` instead of serving static files.
const http=require('http'),fs=require('fs'),path=require('path');
const root=fs.existsSync(path.join(__dirname,'dist','index.html'))?path.join(__dirname,'dist'):__dirname;
const page=()=>fs.readFileSync(path.join(root,'index.html'));
const port=process.env.PORT||3000;
http.createServer((req,res)=>{
  if(req.url==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('ok')}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(page());
}).listen(port,()=>console.log('Ejo is running on port '+port));
