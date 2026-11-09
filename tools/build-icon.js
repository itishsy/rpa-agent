'use strict'
// Deterministic vector geometry; no fonts or external image services are needed.
const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path')
const root=path.resolve(__dirname,'..'),assets=path.join(root,'src/assets')
app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1')
app.setPath('userData',path.join(root,'artifacts/brand-render-profile'))
const phi=(1+Math.sqrt(5))/2,L=256,H=L/phi,stroke=H/phi**5,inset=(L-H)/2,top=inset,bottom=L-inset
// A provides the two shared legs; the open R bowl becomes its curved crossbar.
const span=H/phi,apex=L/2,left=apex-span/2,right=apex+span/2,cross=top+H/phi
const radius=span/2,headCenter={x:apex,y:top+radius}
// A single circular arc has constant curvature: no curve joins or corner at the chin.
const arcPoint=angle=>({x:headCenter.x+radius*Math.cos(angle),y:headCenter.y+radius*Math.sin(angle)})
const arcStart=arcPoint(-Math.PI/3),arcEnd=arcPoint(2*Math.PI/3)
const leftWeight=stroke*(1+1/phi**3)
// Match Runtime's parallel main/projection strokes; retain Agent's own colors.
const leftShift=stroke*phi,projectionOffset=leftWeight*phi,projectionWeight=leftWeight/phi
const innerFoot=left-leftShift+projectionOffset,slope=span/(2*H)
// Intersect the two diagonal centerlines, then trim equally for a tangent crown.
const outerFoot=left-leftShift
const crownControlY=(outerFoot+slope*bottom-apex+slope*top)/(2*slope)
const crownControlX=apex+slope*(crownControlY-top)
const crownTrim=2*(top-crownControlY)
const crownY=crownControlY+crownTrim/2
const crownJoinY=crownControlY+crownTrim
const crownEntryX=crownControlX-slope*crownTrim
const crownExitX=crownControlX+slope*crownTrim
const projectionTop=top+stroke*phi+stroke/phi
const projectionEndX=innerFoot+slope*(bottom-projectionTop)
const f=n=>Number(n.toFixed(3))
const rightStroke=`M${f(outerFoot)} ${f(bottom)}L${f(crownEntryX)} ${f(crownJoinY)}Q${f(crownControlX)} ${f(crownControlY)} ${f(crownExitX)} ${f(crownJoinY)}L${f(right)} ${f(bottom)}`
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="RPA Agent RA monogram">
<title>RPA Agent · RA</title><desc>Minimal RA thinking-person monogram: softened A crown, slightly heavier muted teal left stroke, and a smooth circular R bowl. Golden-ratio construction: canvas/construction height = phi; construction height/leg span = phi; construction height/stroke = phi^5; head diameter = construction height/phi; crown trim = stroke*phi. Phi=${phi}.</desc>
<rect width="256" height="256" rx="${f(L/phi**3)}" fill="#152A3B"/>
<defs><clipPath id="headInterior"><circle cx="${f(headCenter.x)}" cy="${f(headCenter.y)}" r="${f(radius)}"/><rect width="${f(headCenter.x)}" height="256"/><rect width="256" height="${f(headCenter.y)}"/></clipPath></defs>
<g fill="none" stroke="#F8F7F3" stroke-width="${f(stroke)}" stroke-linecap="round" stroke-linejoin="round">
<path d="M${f(innerFoot)} ${f(bottom)}L${f(projectionEndX)} ${f(projectionTop)}" stroke="#56818A" stroke-width="${f(projectionWeight)}"/>
<path d="${rightStroke}"/>
<path d="${rightStroke}" stroke="#90CFCB" stroke-width="${f(leftWeight)}" clip-path="url(#headInterior)"/>
<path d="M${f(arcStart.x)} ${f(arcStart.y)}A${f(radius)} ${f(radius)} 0 0 1 ${f(arcEnd.x)} ${f(arcEnd.y)}"/>
</g></svg>`
app.whenReady().then(async()=>{
  fs.mkdirSync(assets,{recursive:true});fs.writeFileSync(path.join(assets,'ra-mark.svg'),svg)
  const win=new BrowserWindow({show:false,width:1024,height:1024,useContentSize:true,transparent:true,backgroundColor:'#00000000',webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true}})
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html><body style="margin:0;background:transparent"><img style="width:1024px;height:1024px;display:block" src="data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')+'"></body></html>'))
  await win.webContents.executeJavaScript('document.images[0].decode()')
  const raster=await win.webContents.capturePage({x:0,y:0,width:1024,height:1024}),sizes=[16,24,32,48,64,128,256]
  const pngs=sizes.map(size=>raster.resize({width:size,height:size,quality:'best'}).toPNG())
  fs.writeFileSync(path.join(assets,'app.png'),pngs.at(-1));fs.writeFileSync(path.join(assets,'ra-preview.png'),pngs[sizes.indexOf(128)])
  const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length
  sizes.forEach((size,i)=>{const p=6+16*i;header[p]=size===256?0:size;header[p+1]=size===256?0:size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(pngs[i].length,p+8);header.writeUInt32LE(offset,p+12);offset+=pngs[i].length})
  fs.writeFileSync(path.join(assets,'app.ico'),Buffer.concat([header,...pngs]))
  fs.writeFileSync(path.join(assets,'geometry.json'),JSON.stringify({phi,canvas:L,markHeight:H,stroke,leftStroke:leftWeight,leftStrokeColor:'#90CFCB',leftShift,projectionOffset,projectionWeight,projectionColor:'#56818A',projectionTop,projectionEndX,innerFoot,outerFoot,crownControlX,crownControlY,crownEntryX,crownExitX,crownJoinY,crownTrim,crownY,inset,tileRadius:L/phi**3,apexX:apex,crossbarY:cross,leftFootX:left,rightFootX:right,legSpan:span,headDiameter:span,headRadius:radius,headCenter,arcStart,arcEnd,arcSweepDegrees:180,icoSizes:sizes},null,2))
  win.destroy();console.log('RA SVG, PNG and multi-resolution ICO generated from golden-ratio geometry.');app.quit()
}).catch(error=>{console.error(error);app.exit(1)})
