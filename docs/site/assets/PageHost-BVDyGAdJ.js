import{a as e,n as t}from"./rolldown-runtime-sJBDdmOt.js";import{$n as n,$s as r,Aa as i,Al as a,Br as o,Bt as s,Cc as c,Cl as l,Cr as u,Dn as d,Ec as f,En as p,Es as m,Eu as h,Fl as g,Fr as _,Gi as v,Gn as ee,Gr as y,Hi as b,Hr as te,Hs as x,Ht as S,Il as C,Ir as ne,Jl as re,Jn as w,Jo as ie,Jr as T,Ki as E,Kn as ae,Ko as oe,Kr as D,Ml as O,Mr as se,Nc as ce,Nr as le,Or as ue,Pl as de,Pr as fe,Qn as pe,Rc as k,Rr as me,Rt as A,Ru as j,Sl as he,Sr as ge,Tn as _e,Ts as M,Ur as ve,Vi as N,Vl as P,Vr as ye,Vt as be,Wr as F,Ws as xe,Xn as Se,Yn as Ce,Yr as we,Zl as Te,Zn as Ee,Zs as De,_n as Oe,al as ke,au as Ae,bl as I,br as je,cn as Me,el as Ne,fn as Pe,gl as L,gn as R,hr as Fe,il as Ie,jl as z,jr as Le,ka as Re,kl as ze,kr as Be,ll as Ve,mn as B,mr as He,no as Ue,nu as We,pn as Ge,qo as Ke,qr as qe,rr as Je,sn as Ye,to as Xe,tr as Ze,tu as Qe,uc as $e,ur as et,vn as tt,wc as V,wl as nt,wn as rt,wu as it,xn as at,xr as ot,yc as st,yn as ct,yr as lt,zr as ut,zt as dt}from"./startup-WUGHK39s.js";import{n as ft,t as pt}from"./ScreenBand-CUqngkHt.js";import{c as mt,d as ht,f as gt,i as _t,l as vt,n as yt,o as bt,p as xt,r as St,s as Ct,t as wt,u as Tt}from"./OfficeRecoverOffer-B0loHW_X.js";import{i as Et,r as Dt,t as Ot}from"./page-connections-BJMg2aH-.js";function kt(e){window.dispatchEvent(new CustomEvent(`youcoded:compose-insert`,{detail:{ref:{id:Re(),kind:`doc`,path:e.path,fileName:e.name,label:e.name}}}))}function At(e){(window.claude?.shell)?.showItemInFolder?.(e.path)}function jt(e){navigator.clipboard?.writeText(e.path).catch(()=>{})}function Mt(e,t,n){let r=it().openInOs;return[{type:`item`,id:`open`,label:`Open`,icon:`open`,primary:!0,run:()=>t.open(e)},{type:`item`,id:`ask`,label:`Ask about this`,icon:`ask`,run:()=>kt(e)},{type:`sep`},{type:`item`,id:`rename`,label:`Rename`,icon:`rename`,run:n},{type:`item`,id:`copy`,label:`Make a copy`,icon:`copy`,run:()=>t.duplicate(e)},...r?[{type:`item`,id:`reveal`,label:`View in folder`,icon:`folder`,run:()=>At(e)}]:[],{type:`item`,id:`copy-path`,label:`Copy as path`,icon:`path`,run:()=>jt(e)},...t.forget?[{type:`sep`},{type:`item`,id:`forget`,label:`Remove from Recent`,icon:`remove`,run:()=>t.forget(e)}]:[]]}function Nt(){return(0,U.jsxs)(`svg`,{width:12,height:12,viewBox:`0 0 24 24`,fill:`none`,stroke:`currentColor`,strokeWidth:2,strokeLinecap:`round`,strokeLinejoin:`round`,"aria-hidden":`true`,children:[(0,U.jsx)(`path`,{d:`M12 20h9`}),(0,U.jsx)(`path`,{d:`M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z`})]})}function Pt(){return(0,U.jsxs)(`svg`,{width:14,height:14,viewBox:`0 0 24 24`,fill:`currentColor`,"aria-hidden":`true`,children:[(0,U.jsx)(`circle`,{cx:`5`,cy:`12`,r:`1.8`}),(0,U.jsx)(`circle`,{cx:`12`,cy:`12`,r:`1.8`}),(0,U.jsx)(`circle`,{cx:`19`,cy:`12`,r:`1.8`})]})}function Ft({label:e,onClick:t,children:n,...r}){return(0,U.jsx)(I,{text:e,children:(0,U.jsx)(`button`,{type:`button`,"aria-label":e,className:zt,onClick:e=>{e.stopPropagation(),t(e)},...r,children:n})})}function It({f:e,actions:t,onClose:n}){let[i,a]=(0,H.useState)(Lt(e.name)),[o,s]=(0,H.useState)(null),[c,l]=(0,H.useState)(!1),u=(0,H.useRef)(!0);(0,H.useEffect)(()=>()=>{u.current=!1},[]);let d=Rt(e.name),f=async()=>{let r=i.trim();if(!r||c)return;if(r===Lt(e.name)){n();return}l(!0),s(null);let a=await t.rename(e,`${r}${d}`);u.current&&(l(!1),a?s(a):n())};return(0,U.jsxs)(r,{open:!0,screen:`office/rename`,title:`Rename file`,size:`panel`,layer:3,onClose:()=>{c||n()},children:[o&&(0,U.jsx)(V,{message:o,onRetry:()=>void f(),variant:`inline`}),(0,U.jsx)(`form`,{className:`space-y-3`,onSubmit:e=>{e.preventDefault(),f()},children:(0,U.jsx)(x,{actions:(0,U.jsxs)(U.Fragment,{children:[(0,U.jsx)(L,{type:`submit`,disabled:c||!i.trim(),children:c?`Saving…`:`Save`}),(0,U.jsx)(L,{variant:`secondary`,type:`button`,disabled:c,onClick:n,children:`Cancel`})]}),children:(0,U.jsxs)(`div`,{children:[(0,U.jsx)(xe,{htmlFor:`office-file-name`,children:`File name`}),(0,U.jsxs)(`div`,{className:`relative`,children:[(0,U.jsx)(Ne,{id:`office-file-name`,value:i,disabled:c,onChange:e=>{a(e.target.value),s(null)},autoFocus:!0,onFocus:e=>e.currentTarget.select(),maxLength:200,className:`w-full`}),d&&(0,U.jsxs)(`span`,{"aria-hidden":`true`,className:`pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre border border-transparent px-3 text-xs`,children:[(0,U.jsx)(`span`,{className:`invisible`,children:i}),(0,U.jsx)(`span`,{className:`text-fg-faint`,children:d})]})]})]})})})]})}var H,U,Lt,Rt,zt,Bt,Vt,Ht,Ut,Wt=t((()=>{H=e(j()),h(),b(),E(),i(),M(),Tt(),U=P(),Lt=e=>{let t=e.lastIndexOf(`.`);return t>0?e.slice(0,t):e},Rt=e=>{let t=e.lastIndexOf(`.`);return t>0?e.slice(t):``},zt=`shrink-0 w-7 h-7 rounded-md inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-well active:bg-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse-hit cursor-pointer`,Bt=`transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none`,Vt=`absolute inset-y-0 right-0 flex items-center whitespace-nowrap text-2xs text-fg-muted ${Bt} group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0`,Ht=`absolute inset-y-0 right-0 flex items-center gap-0.5 ${Bt} opacity-0 translate-x-1 pointer-events-none group-hover:opacity-100 group-hover:translate-x-0 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:translate-x-0 group-focus-within:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:translate-x-0 pointer-coarse:pointer-events-auto motion-reduce:translate-x-0`,Ut=(0,H.memo)(function({f:e,verb:t,when:n,actions:r,startRenaming:i=!1,startMenu:a=!1,pointed:o=!1}){let[s,c]=(0,H.useState)(i),[l,u]=(0,H.useState)(null),d=(0,H.useRef)(null),f=it().openInOs,p=(e,t)=>u({x:e,y:t});return(0,H.useEffect)(()=>{if(!a||!d.current)return;let e=d.current.getBoundingClientRect();u({x:e.right-200,y:e.bottom-6})},[a]),(0,U.jsxs)(U.Fragment,{children:[(0,U.jsxs)(`div`,{ref:d,role:`button`,tabIndex:0,"aria-label":e.name,onClick:()=>r.open(e),onKeyDown:t=>{if(t.target===t.currentTarget&&((t.key===`Enter`||t.key===` `)&&(t.preventDefault(),r.open(e)),t.key===`F2`&&(t.preventDefault(),c(!0)),t.key===`ContextMenu`||t.shiftKey&&t.key===`F10`)){t.preventDefault();let e=t.currentTarget.getBoundingClientRect();p(e.left+40,e.bottom-4)}},onContextMenu:e=>{e.preventDefault(),e.stopPropagation(),p(e.clientX,e.clientY)},className:`group flex items-center gap-3 h-11 px-2 rounded-md cursor-pointer text-left hover:bg-inset active:bg-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent select-none ${o?`bg-inset`:``}`,children:[(0,U.jsx)(vt,{kind:e.kind,className:`w-4 h-4 shrink-0 text-fg-2`}),(0,U.jsxs)(`div`,{className:`min-w-0 flex-1`,children:[(0,U.jsxs)(`div`,{className:`flex items-center gap-1.5 min-w-0`,children:[(0,U.jsx)(`span`,{className:`text-sm text-fg truncate`,children:e.name}),(0,U.jsx)(`button`,{type:`button`,"aria-label":`Rename ${e.name}`,"aria-haspopup":`dialog`,className:`shrink-0 text-fg-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm coarse-hit cursor-pointer`,onClick:e=>{e.stopPropagation(),c(!0)},children:(0,U.jsx)(Nt,{})})]}),(0,U.jsx)(`div`,{className:`text-2xs text-fg-muted truncate`,children:e.folder})]}),(0,U.jsxs)(`div`,{className:`relative shrink-0 w-32 h-7`,children:[(0,U.jsxs)(`span`,{className:`${Vt} ${o?`!opacity-0`:``}`,children:[t,` `,n]}),(0,U.jsxs)(`div`,{className:`${Ht} ${o?`!opacity-100 !translate-x-0`:``}`,children:[(0,U.jsx)(Ft,{label:`Ask about this`,onClick:()=>kt(e),children:(0,U.jsx)(v,{name:`ask`})}),f&&(0,U.jsx)(Ft,{label:`View in folder`,onClick:()=>At(e),children:(0,U.jsx)(v,{name:`folder`})}),(0,U.jsx)(Ft,{label:`More`,"aria-haspopup":`menu`,onClick:e=>{let t=e.currentTarget.getBoundingClientRect();p(t.left,t.bottom+4)},children:(0,U.jsx)(Pt,{})})]})]})]}),l&&(0,U.jsx)(N,{x:l.x,y:l.y,anchor:d.current??void 0,entries:Mt(e,r,()=>c(!0)),onClose:()=>u(null)}),s&&(0,U.jsx)(It,{f:e,actions:r,onClose:()=>{c(!1),d.current?.focus()}})]})})}));function W(){return window.claude?.office}function Gt({projectRoot:e=null,visible:t=!0}){let{docs:n,active:r,versionsFor:i}=ne(),[a,o]=(0,G.useState)({state:`loading`}),[s,c]=(0,G.useState)(null),l=(0,G.useRef)(0),u=()=>{let t=W();if(!t){o({state:`unavailable`});return}let n=++l.current;if(t.status(null).then(e=>{n===l.current&&o(e.available?{state:`ready`,status:e}:{state:`unavailable`})},e=>{n===l.current&&o(/^remote-unsupported:/.test(String(e?.message??``))?{state:`unavailable`}:{state:`failed`})}),e){let r=e;t.status(r).then(e=>{n===l.current&&c({root:r,value:e.available?e.project:null})},()=>{})}},d=r===ee;(0,G.useEffect)(()=>{t&&d&&u()},[e,t,d]);let f=(0,G.useRef)(new Map),p=n.find(e=>e.file.path===r&&!e.closing)??null,h=me(p?.file.path??null),g=fe(p?.file.path??null),_=p?.file.path??null,v=(0,G.useMemo)(()=>({get current(){return _?f.current.get(_):void 0}}),[_]),y=(0,G.useRef)(null);(0,G.useEffect)(()=>{if(t)return;let e=document.activeElement;e&&y.current?.contains(e)&&e.blur()},[t]);let b=[{id:ee,label:`Home`,icon:(0,K.jsx)(Ct,{}),closable:!1},...n.filter(e=>!e.closing).map(e=>({id:e.file.path,label:xt(e.file.name),icon:(0,K.jsx)(vt,{kind:e.file.kind}),asleep:e.asleep,closeNote:g&&e.file.path===p?.file.path?`Saving a copy…`:void 0}))],[x,S]=(0,G.useState)(null),[C,re]=(0,G.useState)(null),w=async t=>{S(null);try{let n=await W()?.create(t,e);if(!n)return;if(!n.ok){S({message:n.message,general:!1,retry:()=>void w(t)});return}lt(n.file)}catch(e){console.error(`[Office] creating a new file failed`,e),S({message:`Office couldn't create a new file.`,general:!0,retry:()=>void w(t)})}},ie=async()=>{S(null);try{let e=await W()?.pick();e&&lt(e)}catch(e){console.error(`[Office] the file picker failed`,e),S({message:`Office couldn't open the file picker.`,general:!0,retry:()=>void ie()})}},T=s&&s.root===e?s.value:null;return(0,K.jsxs)(`div`,{ref:y,className:`absolute inset-0 flex flex-col`,children:[(0,K.jsxs)(`div`,{className:`min-h-11 shrink-0 flex items-center gap-2 px-2 ${r===`home`?`border-b border-edge-dim`:`border-b border-transparent`}`,children:[(0,K.jsx)(m,{label:`Open documents`,tabs:b,activeId:r,onSelect:Le,onClose:Se,className:`flex-1`}),p&&(0,K.jsxs)(`div`,{className:`shrink-0 flex items-center gap-2 pl-2`,children:[(0,K.jsx)(wt,{path:p.file.path,frame:v,className:`max-w-xl`}),h.phase!==`failed`&&h.note&&(0,K.jsx)(I,{text:h.note,children:(0,K.jsx)(`span`,{className:`text-2xs text-fg-muted truncate max-w-xs`,role:`status`,children:h.note})}),h.phase===`failed`?(0,K.jsx)(St,{path:p.file.path,className:`max-w-xl`,message:h.message??`Office couldn't save this file.`,frame:v,visible:t,retry:!h.keptAfterRestore,onCloseWithoutSaving:()=>Se(p.file.path)}):(0,K.jsx)(`span`,{className:`text-2xs text-fg-muted`,children:Kt(h)}),(0,K.jsxs)(L,{variant:`ghost`,size:`sm`,onClick:()=>se(p.file),disabled:g,children:[(0,K.jsx)(bt,{}),`Versions`]})]})]}),(0,K.jsxs)(`div`,{className:`relative flex-1 min-h-0`,children:[r===`home`&&(0,K.jsx)(qt,{load:a,project:T,onRetry:u,onCreate:w,onPick:ie,onOpen:lt,onChanged:u,actionError:x&&(x.general?(0,K.jsx)(V,{variant:`inline`,message:x.message,onRetry:x.retry,onReportBug:()=>re({surface:`Office`,error:x.message}),onDiagnose:()=>re({surface:`Office`,error:x.message,diagnose:!0})}):(0,K.jsx)(V,{variant:`inline`,message:x.message,onRetry:x.retry}))}),n.filter(e=>!e.asleep).map(e=>(0,K.jsx)(ht,{ref:t=>{t?f.current.set(e.file.path,t):f.current.delete(e.file.path)},file:e.file,hidden:e.closing||e.file.path!==r,screen:t?`office/${e.file.kind}${He()?`-comments`:``}`:void 0,closing:e.closing,onClosed:()=>pe(e.file.path),onCloseFailed:()=>{ae(e.file.path),t||et(e.file.path)},onSwitchTo:(t,n)=>{ue(e.file.path,te(t)),Je(t,n)}},e.file.path))]}),(0,K.jsx)($t,{file:i,shown:t,onClose:()=>se(null)}),(0,K.jsx)(Xe,{open:t&&!!C,onClose:()=>re(null),context:C??void 0})]})}function Kt(e){return e.phase===`unsaved`?`Edited`:e.phase===`saved`?e.copiedTo?`Saved a copy to ${e.copiedTo} — now editing the copy.`:`Saved`:`Saving…`}function qt({load:e,project:t,actionError:n,onRetry:r,onCreate:i,onPick:a,onOpen:o,onChanged:s}){let l=We()?new URLSearchParams(location.search).get(`officeHome`):null,[u,d]=(0,G.useState)(l===`search`?`garden`:``),[p,m]=(0,G.useState)(!1),[h,g]=(0,G.useState)(null),_=Jt(o,s,g),ee=(0,G.useMemo)(()=>({..._,forget:e=>void Yt(e,s,g)}),[_,s]);if(e.state===`failed`)return(0,K.jsx)(`div`,{className:`p-6 max-w-xl mx-auto`,children:(0,K.jsx)(V,{message:`Office could not be started.`,onRetry:r})});if(e.state===`unavailable`)return(0,K.jsx)(`div`,{className:`p-6 max-w-xl mx-auto`,children:(0,K.jsx)(c,{message:`Office isn't included in this build.`})});let y=e.state===`ready`?e.status.recent:null,b=(t?.files??[]).filter(e=>!y?.some(t=>t.path===e.path)),te=u.trim().toLowerCase(),x=e=>!te||e.name.toLowerCase().includes(te),S=(y??[]).filter(x),C=b.filter(x),ne=p||te?C:C.slice(0,nn),re=C.length-ne.length,w=!!te&&y!==null&&S.length===0&&C.length===0,ie=(y?.length??0)+b.length>0;return(0,K.jsxs)(`div`,{className:`scroll-mask absolute inset-0 overflow-y-auto`,children:[y&&(0,K.jsx)(ze,{name:y.length===0?`office/first-run`:`office/home`}),(0,K.jsxs)(`div`,{className:`w-full max-w-4xl mx-auto px-4 py-6 flex flex-col gap-7`,children:[n,(0,K.jsxs)(`section`,{className:`flex flex-col gap-3`,children:[(0,K.jsx)(Xt,{children:`New`}),(0,K.jsx)(`div`,{className:`grid gap-3 grid-cols-1 sm:grid-cols-3`,children:[`document`,`spreadsheet`,`presentation`].map(e=>(0,K.jsx)(Zt,{kind:e,onClick:()=>i(e)},e))})]}),(0,K.jsxs)(`section`,{className:`flex flex-col gap-2`,children:[(0,K.jsxs)(`div`,{className:`flex items-center gap-3`,children:[(0,K.jsx)(Xt,{children:`Recent`}),(0,K.jsx)(`div`,{className:`flex-1`}),(0,K.jsxs)(L,{variant:`secondary`,size:`sm`,onClick:a,children:[(0,K.jsx)(v,{name:`folder`}),`Browse files`]}),ie&&(0,K.jsx)($e,{value:u,onChange:d,placeholder:`Search files`,inputAriaLabel:`Search your Office files`,className:`w-56 max-sm:w-40`})]}),h&&(0,K.jsx)(V,{variant:`inline`,message:h.message,onRetry:h.retry}),y===null?(0,K.jsx)(f,{what:`Recent`,variant:`inline`}):y.length===0?(0,K.jsx)(c,{message:`Files you open in Office will show up here.`}):w?(0,K.jsx)(c,{message:`No files match “${u.trim()}”.`}):S.length===0&&te?(0,K.jsx)(`div`,{className:`px-2 text-xs text-fg-muted`,children:`No recent files match.`}):(0,K.jsx)(Qt,{files:S,verb:`Opened`,actions:ee,preview:l})]}),ne.length>0&&t&&(0,K.jsxs)(`section`,{className:`flex flex-col gap-2`,children:[(0,K.jsxs)(Xt,{children:[`In `,t.name]}),(0,K.jsx)(Qt,{files:ne,verb:`Changed`,actions:_}),re>0&&(0,K.jsx)(`div`,{className:`px-1`,children:(0,K.jsxs)(L,{variant:`ghost`,size:`sm`,onClick:()=>m(!0),children:[`Show all `,C.length]})})]})]})]})}function Jt(e,t,r){let i=(0,G.useCallback)(async(e,r)=>{try{let i=le(e.path);if(i){if(!(await n(e.path)).ok)return`Your latest changes couldn't be saved, so the file wasn't renamed.`;Se(e.path),await o(e.path)}let a;try{a=await W()?.rename?.(e.path,r)}finally{i&&u(e.path,a?.ok?a.file:e,i)}return a?a.ok?(t(),null):a.message:`Office couldn't rename this file.`}catch{return`Office couldn't rename this file.`}},[t]),a=(0,G.useCallback)(function e(n){r(null);let i=t=>r({message:t,retry:()=>e(n)});(W()?.duplicate?.(n.path)??Promise.resolve(null)).then(e=>{e?e.ok?t():i(e.message):i(`Office couldn't make a copy of this file.`)},()=>i(`Office couldn't make a copy of this file.`))},[t,r]);return(0,G.useMemo)(()=>({open:e,rename:i,duplicate:a}),[e,i,a])}async function Yt(e,t,n){n(null);try{await W()?.forgetRecent?.(e.path),t()}catch{n({message:`Office couldn't remove this file from Recent.`,retry:()=>void Yt(e,t,n)})}}function Xt({children:e}){return(0,K.jsx)(De,{className:`px-1`,children:e})}function Zt({kind:e,onClick:t}){return(0,K.jsxs)(`div`,{role:`button`,tabIndex:0,onClick:t,onKeyDown:e=>{(e.key===`Enter`||e.key===` `)&&(e.preventDefault(),t())},className:`bg-panel border border-edge rounded-lg p-4 flex items-center gap-3 cursor-pointer card-interactive card-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-accent select-none`,children:[(0,K.jsx)(`span`,{className:`shrink-0 w-9 h-9 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-fg-2`,children:(0,K.jsx)(vt,{kind:e,className:`w-5 h-5`})}),(0,K.jsxs)(`div`,{className:`min-w-0`,children:[(0,K.jsx)(`div`,{className:`text-sm font-medium text-fg`,children:mt[e]}),(0,K.jsx)(`div`,{className:`text-xs text-fg-muted`,children:rn[e]})]})]})}function Qt({files:e,verb:t,actions:n,preview:r=null}){return(0,K.jsx)(`div`,{className:`flex flex-col`,children:e.map((e,i)=>(0,K.jsx)(Ut,{f:e,verb:t,when:en(e.at),actions:n,startRenaming:r===`rename`&&i===0,startMenu:r===`menu`&&i===0,pointed:r===`hover`&&i===0},e.path))})}function $t({file:e,shown:t,onClose:i}){let[a,o]=(0,G.useState)(null),[s,l]=(0,G.useState)(!1),[u,d]=(0,G.useState)(null),[p,m]=(0,G.useState)(null),[h,g]=(0,G.useState)(0);(0,G.useEffect)(()=>{if(o(null),l(!1),m(null),!e)return;let t=!0;return W()?.versions(e.path).then(e=>{t&&o(e)},()=>{t&&l(!0)}),()=>{t=!1}},[e,h]);let _=async t=>{if(e&&!u){d(t.id),m(null);try{if(!(await n(e.path)).ok){m({message:`Your latest changes couldn't be saved, so nothing was restored.`,version:t});return}let r=await(W()?.restore(e.path,t.id)??Promise.resolve({ok:!1,message:on})).catch(()=>({ok:!1,message:on}));if(r.ok){i();return}m({message:r.message,version:t})}finally{d(null)}}};return(0,K.jsxs)(r,{open:e!==null&&t,onClose:i,busy:u!==null,title:`Versions`,subtitle:e?.name,size:`panel`,screen:`office/versions`,children:[p&&(0,K.jsx)(V,{message:p.message,onRetry:()=>void _(p.version)}),(0,K.jsxs)(`div`,{className:`${Ie} p-3 space-y-2`,children:[(0,K.jsx)(`p`,{className:`text-xs text-fg-muted`,children:`Office saves as you work and keeps a copy every few minutes. Restoring one keeps your current version too.`}),s&&(0,K.jsx)(V,{message:`Office couldn't load the versions of this file.`,onRetry:()=>g(e=>e+1)}),a===null&&!s&&(0,K.jsx)(f,{what:`versions`}),a&&a.length===0&&(0,K.jsx)(c,{message:`No earlier versions yet.`}),a&&a.length>0&&(0,K.jsxs)(`div`,{className:`flex flex-col`,children:[(0,K.jsx)(`div`,{className:`flex items-center gap-3 h-11 px-2`,children:(0,K.jsxs)(`div`,{className:`min-w-0 flex-1`,children:[(0,K.jsx)(`div`,{className:`text-sm text-fg`,children:`Now`}),(0,K.jsx)(`div`,{className:`text-2xs text-fg-muted`,children:`The version you are editing`})]})}),a.map(e=>(0,K.jsxs)(`div`,{className:`flex items-center gap-3 h-11 px-2 rounded-md hover:bg-inset`,children:[(0,K.jsxs)(`div`,{className:`min-w-0 flex-1`,children:[(0,K.jsx)(`div`,{className:`text-sm text-fg`,children:tn(e.at)}),(0,K.jsx)(`div`,{className:`text-2xs text-fg-muted`,children:an[e.reason]})]}),(0,K.jsx)(L,{variant:`secondary`,size:`sm`,onClick:()=>void _(e),disabled:u!==null,children:u===e.id?`Restoring…`:`Restore`})]},e.id))]})]})]})}function en(e){let t=Date.now()-new Date(e).getTime();if(!Number.isFinite(t)||t<0)return`just now`;let n=Math.floor(t/6e4);if(n<1)return`just now`;if(n<60)return`${n} min ago`;let r=Math.floor(n/60);if(r<24)return`${r} h ago`;let i=Math.floor(r/24);return i<30?`${i} d ago`:new Date(e).toLocaleDateString()}function tn(e){let t=new Date(e),n=t.toLocaleTimeString([],{hour:`numeric`,minute:`2-digit`}),r=new Date,i=new Date(r);return i.setDate(r.getDate()-1),t.toDateString()===r.toDateString()?`Today, ${n}`:t.toDateString()===i.toDateString()?`Yesterday, ${n}`:`${t.toLocaleDateString([],{day:`numeric`,month:`short`})}, ${n}`}var G,K,nn,rn,an,on,sn=t((()=>{G=e(j()),M(),Wt(),E(),Qe(),Tt(),Ze(),ye(),_t(),yt(),gt(),a(),Ue(),K=P(),nn=12,rn={document:`A blank Word file`,spreadsheet:`A blank Excel file`,presentation:`A blank PowerPoint file`},an={opened:`When you opened it`,autosave:`Saved while you worked`,"before-restore":`Kept before a restore`},on=`Office couldn't restore this version.`}));function q(e,t){t?pn.set(e,t):pn.delete(e),mn+=1,hn.forEach(e=>e())}function cn(){return(0,J.useSyncExternalStore)(e=>(hn.add(e),()=>{hn.delete(e)}),()=>mn,()=>mn)}async function ln(e,t={}){q(e,{kind:`saving`});let n=await e.parked.save(t).catch(e=>({error:`Save failed: ${String(e)}`}));`ok`in n?q(e,null):`needsConfirm`in n?q(e,{kind:`confirm-settings`}):`protected`in n?q(e,{kind:`protected`}):`conflict`in n?q(e,{kind:`conflict`,unknown:n.unknown,confirmed:t.confirmed}):q(e,{kind:`error`,message:n.error})}function un({edit:e,status:t,onRetry:n}){cn();let r=pn.get(e)??null,i=()=>q(e,{kind:`confirm-discard`,back:r}),a=(e,t,n=`secondary`,r=!1)=>(0,Y.jsx)(L,{variant:n,size:`sm`,onClick:t,disabled:r,children:e}),o=null,s=null,c=null;return e.parked?r?.kind===`confirm-discard`?c={tone:`warning`,text:`Discard your changes to this file?`,actions:(0,Y.jsxs)(Y.Fragment,{children:[a(`Cancel`,()=>q(e,r.back)),a(`Discard`,()=>{q(e,null),e.discard()},`danger`)]})}:t===`protected`||r?.kind===`protected`?(o=`Can’t be saved here`,s=a(`Discard`,i)):t===`gone`?(o=`The file is no longer there`,s=a(`Discard`,i)):t&&typeof t==`object`?c={tone:`danger`,text:t.error,actions:(0,Y.jsxs)(Y.Fragment,{children:[a(`Discard`,i),a(`Try again`,n,`primary`)]})}:r?.kind===`conflict`?c={tone:`warning`,text:r.unknown?`YouCoded can’t tell whether this file changed on disk.`:`Changed on disk since you opened it.`,actions:(0,Y.jsxs)(Y.Fragment,{children:[a(`Discard`,i),a(`Save anyway`,()=>q(e,{kind:`confirm-overwrite`,unknown:r.unknown,confirmed:r.confirmed}),`primary`)]})}:r?.kind===`confirm-overwrite`?c={tone:`warning`,text:`Replace the file on disk with your version?`,actions:(0,Y.jsxs)(Y.Fragment,{children:[a(`Cancel`,()=>q(e,{kind:`conflict`,unknown:r.unknown,confirmed:r.confirmed})),a(`Replace`,()=>void ln(e,{force:!0,...r.confirmed?{confirmed:!0}:{}}),`danger`)]})}:r?.kind===`confirm-settings`?c={tone:`warning`,text:`This is a settings file. Save anyway?`,actions:(0,Y.jsxs)(Y.Fragment,{children:[a(`Cancel`,()=>q(e,null)),a(`Save anyway`,()=>void ln(e,{confirmed:!0}),`danger`)]})}:r?.kind===`error`?c={tone:`danger`,text:r.message,actions:(0,Y.jsxs)(Y.Fragment,{children:[a(`Discard`,i),a(`Try again`,()=>void ln(e),`primary`)]})}:t===`editable`&&(o=`Not saved yet`,s=a(r?.kind===`saving`?`Saving…`:`Save`,()=>void ln(e),`primary`,r?.kind===`saving`)):o=`Open in this window — save it there`,(0,Y.jsxs)(`li`,{className:`${ke} px-3 py-1`,children:[(0,Y.jsx)(k,{header:!0,variant:`item`,title:e.name,description:o??void 0,control:s??void 0}),c&&(0,Y.jsx)(ce,{compact:!0,tone:c.tone,className:`mb-2`,actions:c.actions,children:c.text})]})}function dn(){if(gn.length>0)return;let e=async()=>({error:`preview`}),t=t=>({available:async()=>t,save:e});gn=[F({name:`notes.md`,discard:()=>{}}),F({name:`plan.txt`,parked:t(`editable`),discard:()=>{}}),F({name:`budget.csv`,parked:t(`editable`),discard:()=>{}}),F({name:`config.yaml`,parked:t(`editable`),discard:()=>{}}),F({name:`old-draft.txt`,parked:t(`gone`),discard:()=>{}}),F({name:`shared.md`,parked:t({error:`YouCoded couldn’t read this file: permission denied.`}),discard:()=>{}})],queueMicrotask(()=>{let e=D(),t=t=>e.find(e=>e.name===t),n=t(`budget.csv`),r=t(`config.yaml`);n&&q(n,{kind:`conflict`}),r&&q(r,{kind:`error`,message:`Save failed: this folder can't be written to.`})})}var J,Y,fn,pn,mn,hn,gn,_n=t((()=>{J=e(j()),M(),a(),Ze(),we(),y(),Y=P(),fn=J.memo(function(){let{quitRefused:e}=_(),t=qe();z(`app/unsaved-before-quit`,()=>{dn(),ge()}),z(`app/unsaved-before-quit/after-restart`,()=>{dn(),ge({afterTeardown:!0,restartDropped:!0})}),z(`app/unsaved-before-quit/discard`,()=>{dn(),ge({confirming:!0})});let[n,i]=(0,J.useState)([]),[a,o]=(0,J.useState)(new Map),[s,c]=(0,J.useState)(0);(0,J.useEffect)(()=>{if(!e)return;let n=!0;return Promise.all(t.filter(e=>e.parked).map(async e=>[e,await e.parked.available().catch(e=>(console.error(`[UnsavedBeforeQuit] checking a parked draft failed`,e),{error:T}))])).then(e=>{n&&o(new Map(e))}),()=>{n=!1}},[e,t,s]),cn();let l=t.some(e=>pn.get(e)?.kind===`saving`),u=t.length,d=u===1?`1 file`:`${u} files`,f=e?.mode===`close`?`close`:`quit`,p=()=>{Ce(),window.claude?.office?.proceedClose?.()},m=(0,J.useRef)(!1),h=()=>{m.current=!0,ve(n).then(()=>{m.current=!1,p()})},g=()=>{Ce(),window.claude?.office?.dismissPrompt?.()},v=e!==null&&u===0;(0,J.useEffect)(()=>{v&&!m.current&&p()},[v]);let ee=u>1?`${u} files have unsaved changes.`:`A file has unsaved changes.`,y=e?.afterTeardown?`${ee} Your chats have stopped. Save ${u>1?`the files`:`the file`}, then quit again.`:`${ee} Save ${u>1?`them`:`it`}, then ${f===`close`?`close the window`:`quit`} again.`,b=e?.restartDropped?` YouCoded will quit instead of restarting.`:``;return(0,Y.jsx)(r,{open:e!==null&&!v,onClose:g,title:`Unsaved changes`,size:`panel`,layer:3,screen:e?.confirming?`app/unsaved-before-quit/discard`:e?.afterTeardown?`app/unsaved-before-quit/after-restart`:`app/unsaved-before-quit`,footer:e?.confirming?(0,Y.jsxs)(`div`,{className:`flex flex-col gap-2`,children:[(0,Y.jsxs)(`p`,{className:`text-sm text-fg-2 pb-1`,children:[`Discard unsaved changes to `,d,`?`]}),(0,Y.jsxs)(L,{variant:`danger`,className:`w-full`,onClick:h,disabled:l,children:[`Discard and `,f]}),(0,Y.jsx)(L,{variant:`secondary`,className:`w-full`,onClick:()=>Ee(!1),children:`Cancel`})]}):(0,Y.jsxs)(`div`,{className:`flex flex-col gap-2`,children:[(0,Y.jsx)(L,{variant:`primary`,className:`w-full`,onClick:g,children:`Keep editing`}),(0,Y.jsxs)(L,{variant:`secondary`,className:`w-full`,disabled:l,onClick:()=>{i(t),Ee(!0)},children:[`Discard and `,f]})]}),children:(0,Y.jsxs)(`div`,{className:`${Ie} p-3 flex flex-col gap-3`,children:[(0,Y.jsx)(`p`,{className:`text-sm text-fg-2`,children:`${y}${b}`}),(0,Y.jsx)(`ul`,{className:`flex flex-col gap-2`,children:t.map((e,t)=>(0,Y.jsx)(un,{edit:e,status:a.get(e),onRetry:()=>c(e=>e+1)},`${e.name}-${t}`))})]})})}),pn=new WeakMap,mn=0,hn=new Set,gn=[]}));function vn({onReview:e}){let{closeFailed:t}=_();return(0,yn.useEffect)(()=>{ut()},[]),(0,bn.jsxs)(bn.Fragment,{children:[(0,bn.jsx)(fn,{}),t&&(0,bn.jsx)(st,{tone:`error`,message:`An Office document couldn't be saved.`,durationMs:1e4,onDismiss:w,action:(0,bn.jsx)(L,{variant:`secondary`,size:`sm`,onClick:()=>{let n=t;w(),e(n)},children:`Open Office`})},t)]})}var yn,bn,xn=t((()=>{yn=e(j()),M(),Ze(),_n(),bn=P()}));function Sn({onMake:e}){return(0,X.jsx)(`div`,{className:`flex-1 flex items-center justify-center max-sm:items-start px-2 py-8 min-h-0`,children:(0,X.jsxs)(`div`,{className:`w-full max-w-xl bg-panel border border-edge rounded-lg p-5 sm:p-6 flex flex-col items-center text-center gap-4 sm:flex-row sm:items-start sm:text-left`,children:[(0,X.jsx)(`span`,{"aria-hidden":`true`,className:`shrink-0 inline-flex w-16 h-16 rounded-lg bg-inset border border-edge-dim items-center justify-center text-fg-dim`,children:(0,X.jsx)(_e,{className:`w-8 h-8`})}),(0,X.jsxs)(`div`,{className:`min-w-0 flex flex-col gap-3 items-center sm:items-start`,children:[(0,X.jsxs)(`div`,{children:[(0,X.jsx)(De,{className:`mb-1`,children:`Pages`}),(0,X.jsx)(`h3`,{className:`text-base font-semibold text-fg leading-snug`,children:`Pages are little apps you describe`})]}),(0,X.jsx)(`p`,{className:`text-sm text-fg-2 leading-relaxed`,children:`Tell the assistant what you want — a calendar that pulls your accounts together, a news feed built around your interests, an email browser that works your way, a timesheet tracker for your team — and it builds a page that looks like the rest of YouCoded and follows your theme.`}),(0,X.jsx)(`p`,{className:`text-sm text-fg-2 leading-relaxed`,children:`Pin the ones you use most and they get their own button up top.`}),(0,X.jsx)(L,{variant:`primary`,onClick:e,className:`w-full`,children:`Make a page`})]})]})})}var X,Cn=t((()=>{j(),M(),d(),X=P()})),wn,Tn,En,Dn=t((()=>{wn=`
/* Values the app derives from theme tokens and a page does not receive as tokens, rebuilt from the
   ones it does, with the app's own formulas (globals.css): the card outline (--edge-card), the
   strong outline every outlined button draws (--edge-strong), the control corner (--radius-control:
   the theme's medium corner + 2px, so a theme's shape setting reaches buttons and chips), the
   raised-card shadow (--shadow-card, decisions "Card shadow") and the fixed status hues
   (Tailwind green-400 / amber-500 as the app's @theme sets them). WHY on :root and prefixed: the
   theme's own :root rule is swapped on every theme change and these recompute from it; the
   prefix keeps them from colliding with anything a page defines. */
:root {
  --yc-edge-card: color-mix(in srgb, var(--edge) 82%, var(--fg) 18%);
  --yc-edge-strong: color-mix(in srgb, var(--edge) 65%, var(--fg) 35%);
  --yc-radius-control: calc(var(--radius-md, 12px) + 2px);
  --yc-shadow-card: 0 4px 20px rgb(0 0 0 / 0.16), 0 1px 3px rgb(0 0 0 / 0.08);
  --yc-ok: #4CAF50;
  --yc-warning: oklch(76.9% 0.188 70.08);
  --yc-danger: var(--destructive, #DD4444);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--fg);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
code, pre, kbd, .yc-mono { font-family: var(--font-mono, ui-monospace, monospace); }
a { color: var(--link, var(--accent)); }
a:hover { color: var(--link-hover, var(--accent)); }
h1, h2, h3, h4 { margin: 0; font-weight: 500; line-height: 1.3; }
h1 { font-size: 18px; font-weight: 600; }
h2 { font-size: 16px; }
h3 { font-size: 14px; }
p { margin: 0; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--edge); border-radius: 9999px; border: 2px solid var(--canvas); }
::-webkit-scrollbar-track { background: transparent; }

/* See-through (the host sets this attribute only when the app's page pane is
   glass over the theme's wallpaper AND the person has the page's "Show theme
   background" switch on): the page paints no backdrop of its own, so the pane's
   glass — and the wallpaper under it — is what shows, exactly as in Office.
   WHY the scrollbar border changes too: it was painted --canvas to look inset,
   which would be a visible opaque rim on glass. */
:root[data-yc-see-through] body { background: transparent; }
:root[data-yc-see-through] ::-webkit-scrollbar-thumb { border-color: transparent; background-clip: padding-box; }

.yc-page { max-width: 1100px; margin: 0 auto; padding: 16px; }
.yc-stack { display: flex; flex-direction: column; gap: 12px; }
.yc-row { display: flex; align-items: center; gap: 8px; }
.yc-row--end { justify-content: flex-end; }
.yc-row--between { justify-content: space-between; }
.yc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.yc-spacer { flex: 1; }

/* WHY: dropped the spaced-caps eyebrow look (labels batch, guide: no spaced
   capitals — decisions H-3/L-1…L-4). Class name kept — existing Pages
   reference .yc-eyebrow by name; only its computed style changed, matching
   the app's own SectionLabel: 12px medium grey, normal case, no tracking. */
.yc-eyebrow { font-size: 12px; font-weight: 500; color: var(--fg-muted); }
.yc-title { font-size: 16px; font-weight: 500; color: var(--fg); }
.yc-muted { color: var(--fg-muted); }
.yc-dim { color: var(--fg-dim); }
.yc-faint { color: var(--fg-faint); }
.yc-small { font-size: 12px; }
.yc-caption { font-size: 11px; color: var(--fg-muted); }

/* WHY 12px in and the medium shadow (pages-kit-questions K-4): the guide's Cards recipe — a raised
   card is the panel colour, a thin border, the theme's card corner and the medium shadow, with
   12px inside its edge (Spacing). It was 16px and flat. A card inside a card, and the inset card,
   stay flat: a shadow there reads as a card floating in a card. */
.yc-card {
  background: var(--panel);
  border: 1px solid var(--edge);
  border-radius: var(--radius-lg, 12px);
  padding: 12px;
  box-shadow: var(--yc-shadow-card);
}
.yc-card--inset { background: var(--inset); border-color: var(--edge-dim); box-shadow: none; }
.yc-card .yc-card { box-shadow: none; }
.yc-well { background: var(--well); border: 1px solid var(--edge-dim); border-radius: var(--radius-md, 8px); padding: 12px; }
/* A box inside a card: the app's second-level look (cardLevels.ts CARD_LEVEL_2 = the field
   surface — solid inset, the card outline, the theme's large corner). Every nested box looks the
   same, whatever it holds (guide "Card levels"). */
.yc-box { background: var(--inset); border: 1px solid var(--yc-edge-card); border-radius: var(--radius-lg, 12px); padding: 12px; }
/* WHY tapered (K-4; guide "Card levels": no line crosses the full width of a card, a divider is
   the tapered line): the popup header's line, in the card-outline colour (Dialog.css). It was a
   hard full-width rule. */
.yc-divider { border: 0; margin: 0; height: 1px; background: linear-gradient(to right, transparent, var(--yc-edge-card) 8%, var(--yc-edge-card) 92%, transparent); }

.yc-button {
  appearance: none;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: 12px; font-weight: 500; line-height: 1.2;
  padding: 7px 12px;
  /* WHY the control corner (K-4; guide principle 2): the app's every button takes
     --radius-control, so a theme's shape setting reaches the page's buttons as it does the app's. */
  border-radius: var(--yc-radius-control);
  border: 1px solid var(--edge);
  background: var(--inset);
  color: var(--fg);
  cursor: pointer;
  user-select: none;
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, opacity 150ms ease;
}
.yc-button:hover { background: var(--well); border-color: var(--fg-faint); }
.yc-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.yc-button:disabled { opacity: .5; cursor: default; }
.yc-button--primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.yc-button--primary:hover { background: var(--accent); border-color: var(--accent); opacity: .9; }
/* WHY --ghost draws OUTLINED (K-4; guide "Buttons": everything less important beside the main
   action is outlined with the full-strength outline, never bare text; principle 9: anything
   clickable sits in a container). It is the app's secondary Button exactly — no fill, the strong
   outline, fg-2 words, inset on hover, edge on press. The class name stays so every existing Page
   that wrote --ghost keeps working and simply gains the outline. */
.yc-button--ghost { background: transparent; border-color: var(--yc-edge-strong); color: var(--fg-2); }
.yc-button--ghost:hover { background: var(--inset); border-color: var(--yc-edge-strong); color: var(--fg-2); }
.yc-button--ghost:active { background: var(--edge); }
.yc-button--danger { background: transparent; border-color: var(--destructive, currentColor); color: var(--destructive-fg, var(--fg)); }
.yc-button--danger:hover { background: var(--destructive, transparent); color: var(--on-destructive, var(--fg)); }
.yc-button--sm { font-size: 11px; padding: 4px 10px; }
.yc-button--full { width: 100%; }
.yc-button--icon { width: 28px; height: 28px; padding: 0; }
/* WHY no longer a full pill (K-4; guide principle 2: never write a fixed pill on a control): the
   class still works and takes the theme's control corner like every other button. */
.yc-button--round { border-radius: var(--yc-radius-control); }

/* WHY select.yc-menu beside .yc-select: the design guide tells page authors the kit's dropdown
   is .yc-menu, so a page that writes <select class="yc-menu"> gets the same closed box. */
.yc-input, .yc-textarea, .yc-select, select.yc-menu {
  font: inherit; font-size: 14px; color: var(--fg);
  background: var(--inset);
  border: 1px solid var(--edge);
  border-radius: var(--radius-md, 8px);
  padding: 7px 10px;
  width: 100%;
}
.yc-input::placeholder, .yc-textarea::placeholder { color: var(--fg-muted); }
.yc-input:focus, .yc-textarea:focus, .yc-select:focus, select.yc-menu:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
/* The closed dropdown answers the pointer the way the app's own Select does (field.ts
   FIELD_TRIGGER_STATES): the border, never the fill, which would move under the words. */
.yc-select, select.yc-menu { cursor: pointer; transition: border-color 150ms ease; }
.yc-select:hover, select.yc-menu:hover { border-color: var(--fg-muted); }
.yc-select:disabled, select.yc-menu:disabled { opacity: .5; cursor: not-allowed; }

/* The open dropdown list — the app's own Select menu (ui/Select.tsx): the popup surface
   (panel fill, card outline, the theme's large corner, the popup shadow), rows in the theme's
   middle corner, the current choice filled with the accent, the row under the pointer or the
   arrow keys on inset. PAGE_KIT_JS builds it; a page never writes this markup itself.
   WHY the shadow is the one literal colour: it is the app's popup shadow (globals.css
   .layer-surface), a darkening rather than a theme colour. */
.yc-menu[role="listbox"] {
  position: fixed; z-index: 2147483000;
  display: flex; flex-direction: column;
  min-width: 120px; max-width: calc(100vw - 16px);
  background: var(--panel);
  border: 1px solid var(--edge);
  border-radius: var(--radius-lg, 12px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, .15);
  font-size: 13px; line-height: 1.35; color: var(--fg-2);
  overflow: hidden;
  user-select: none;
}
/* WHY the choices scroll in their own box: a foot action stays in sight however long the list. */
.yc-menu__list { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px; }
.yc-menu__item { display: block; padding: 6px 10px; border-radius: var(--radius-md, 8px); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.yc-menu__item[data-active] { background: var(--inset); }
.yc-menu__item[aria-selected="true"] { background: var(--accent); color: var(--on-accent); font-weight: 500; }
.yc-menu__item[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.yc-menu__group { padding: 8px 10px 2px; font-size: 11px; font-weight: 500; color: var(--fg-muted); }
/* The foot action, behind the tapered line in the card-outline colour (the app's --edge-card,
   rebuilt here from the two tokens a page has). */
.yc-menu__foot { position: relative; flex: none; padding: 4px; }
.yc-menu__foot::before { content: ''; position: absolute; left: 12px; right: 12px; top: 0; height: 1px;
  background: linear-gradient(to right, transparent, var(--yc-edge-card) 8%, var(--yc-edge-card) 92%, transparent); }
/* A finger needs a taller row (the app's coarse-roomy); rows sit flush, so the row grows. */
@media (pointer: coarse) { .yc-menu__item { padding-top: 8px; padding-bottom: 8px; } }
.yc-textarea { min-height: 96px; resize: vertical; }
.yc-label { display: block; font-size: 12px; font-weight: 500; color: var(--fg-2); margin-bottom: 4px; }

.yc-chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-sm, 4px);
  background: var(--inset); border: 1px solid var(--edge-dim); color: var(--fg-2);
}
/* WHY the control corner (K-4): a selectable pill is a filter chip, and the app's filter chips take
   --radius-control, never a hard-coded full pill. */
.yc-pill { border-radius: var(--yc-radius-control); padding: 4px 12px; font-size: 14px; }
.yc-pill--on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }

.yc-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.yc-list-row {
  display: flex; align-items: center; gap: 10px;
  min-height: 40px; padding: 6px 10px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--edge-dim);
  background: var(--panel);
}
.yc-empty { padding: 32px 16px; text-align: center; color: var(--fg-muted); font-size: 14px; }

table.yc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
/* WHY: dropped uppercase + letter-spacing (labels batch, guide: no spaced
   capitals) — this is a table column header, so it keeps its 11px size. */
table.yc-table th { text-align: left; font-size: 11px; color: var(--fg-muted); font-weight: 500; padding: 8px; border-bottom: 1px solid var(--edge); }
table.yc-table td { padding: 8px; border-bottom: 1px solid var(--edge-dim); }

/* App-shaped pages: a toolbar across the top, a tool rail on the left, a
   sidebar on the right, the work in the middle. Added for the paint studio
   and planner samples (shell deck round 1: the first samples were "too
   basic"), so the creator skill has a layout vocabulary, not only controls. */
.yc-app { height: 100%; display: flex; flex-direction: column; }
.yc-app__body { flex: 1; display: flex; min-height: 0; }
.yc-app__main { flex: 1; min-width: 0; position: relative; overflow: auto; }
.yc-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--edge); }
.yc-rail { display: flex; flex-direction: column; gap: 4px; padding: 8px; background: var(--panel); border-right: 1px solid var(--edge); }
.yc-sidebar { width: 232px; padding: 12px; background: var(--panel); border-left: 1px solid var(--edge); overflow: auto; display: flex; flex-direction: column; gap: 16px; }
.yc-tool { width: 36px; height: 36px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-md, 8px); border: 1px solid transparent; background: transparent; color: var(--fg-2); cursor: pointer; }
.yc-tool:hover { background: var(--inset); color: var(--fg); }
.yc-tool--on { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.yc-tool svg { width: 18px; height: 18px; }
/* The slider: the app's own look (ui/Slider.tsx, Destin submit-ticket-5#ST5-5 and #ST6-Q1) —
   a round track, the accent fill to a round handle, its end wrapping the handle. CSS only, as a
   page is plain HTML: the thumb is a white circle ringed in the accent, and its shadow (offset
   left by half a thumb past the track) paints the fill up to the handle's centre; with the ring
   that makes one shape whose end is concentric with the handle. The track clips the shadow. */
.yc-range { -webkit-appearance: none; appearance: none; box-sizing: border-box; width: 100%; height: 20px; margin: 0; border-radius: 999px; background: var(--inset); border: 1px solid var(--edge-dim); overflow: hidden; cursor: pointer; }
.yc-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 3px solid var(--accent); box-shadow: calc(-100vw - 9px) 0 0 100vw var(--accent); }
.yc-range::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 3px solid var(--accent); }
.yc-range::-moz-range-progress { height: 100%; border-radius: 999px; background: var(--accent); }
.yc-range:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.yc-range:disabled { opacity: .5; cursor: not-allowed; }
.yc-swatches { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
.yc-swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--edge); cursor: pointer; padding: 0; }
.yc-swatch--on { outline: 2px solid var(--fg); outline-offset: 2px; }
.yc-kbd { font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; border-radius: var(--radius-sm, 4px); background: var(--inset); border: 1px solid var(--edge-dim); color: var(--fg-2); }
.yc-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-2); }
.yc-badge::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--badge, var(--accent)); }

/* ── The app's own building blocks (pages-kit-questions, 2026-10-16) ──────────────────────────
   Each is the app's primitive redrawn in plain CSS on the page's tokens — sizes, colours and
   corners read from components/ui/*.tsx, never invented. Comments name the primitive. */

/* Status label — ui/Pill.tsx: a small tinted pill, the colour ONLY in the tint and border, the
   words in the normal text colour (guide "Status and notices"). --dot adds the live-status dot
   inside the pill. The pill's round shape is the app's Pill's own (the theme's --radius-full). */
.yc-status {
  display: inline-flex; align-items: center; gap: 4px; flex: none; vertical-align: middle;
  padding: 1px 8px; font-size: 11px; font-weight: 400; line-height: 1.25; white-space: nowrap;
  color: var(--fg-2); background: var(--inset); border: 1px solid var(--edge-dim);
  border-radius: var(--radius-full, 9999px);
}
.yc-status--info { background: color-mix(in oklab, var(--accent) 15%, transparent); border-color: color-mix(in oklab, var(--accent) 30%, transparent); --yc-dot: var(--accent); }
.yc-status--ok { background: color-mix(in oklab, var(--yc-ok) 15%, transparent); border-color: color-mix(in oklab, var(--yc-ok) 30%, transparent); --yc-dot: var(--yc-ok); }
.yc-status--warning { background: color-mix(in oklab, var(--yc-warning) 15%, transparent); border-color: color-mix(in oklab, var(--yc-warning) 30%, transparent); --yc-dot: var(--yc-warning); }
.yc-status--danger { background: color-mix(in oklab, var(--yc-danger) 15%, transparent); border-color: color-mix(in oklab, var(--yc-danger) 30%, transparent); --yc-dot: var(--yc-danger); }
.yc-status--dot { padding-left: 6px; }
.yc-status--dot::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--yc-dot, var(--fg-muted)); }

/* Notice box — ui/Callout.tsx: one tinted box with a matching border; only the box carries the
   colour, the title and words stay the normal text colours. Its buttons sit inside it at the
   right; with a Details fold (.yc-notice__details, a .yc-fold) the box reads sentence → Details →
   buttons, the buttons on their own line at the right BELOW the fold (Destin, gt-r1#E-2/#E-3) —
   whatever order the page wrote them in (the order property). .yc-screen-error is the same box as
   the app's ScreenError: a whole screen that could not load, centred a little below the top
   (pt-24), at a readable width, its buttons full width. */
.yc-notice, .yc-screen-error {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 12px; border: 1px solid; border-radius: var(--radius-lg, 12px);
  font-size: 12px; line-height: 1.333; color: var(--fg-2);
  background: color-mix(in oklab, var(--accent) 10%, transparent);
  border-color: color-mix(in oklab, var(--accent) 25%, transparent);
}
.yc-notice--warning { background: color-mix(in oklab, var(--yc-warning) 10%, transparent); border-color: color-mix(in oklab, var(--yc-warning) 25%, transparent); }
.yc-notice--danger, .yc-screen-error { background: color-mix(in oklab, var(--yc-danger) 10%, transparent); border-color: color-mix(in oklab, var(--yc-danger) 50%, transparent); }
.yc-notice--slim { padding: 6px 10px; gap: 6px 12px; }
.yc-notice:has(.yc-notice__title), .yc-screen-error:has(.yc-notice__title) { align-items: flex-start; }
.yc-notice__text { flex: 1 1 192px; min-width: 0; }
.yc-notice__title { display: block; font-weight: 500; color: var(--fg); margin-bottom: 2px; }
.yc-notice__details { flex: 1 1 100%; order: 1; }
.yc-notice__details code, .yc-notice__details pre { display: block; margin: 0; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--fg-2); white-space: pre-wrap; word-break: break-all; }
.yc-notice__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; order: 2; }
.yc-notice:has(> .yc-notice__details) > .yc-notice__actions, .yc-screen-error > .yc-notice__actions { flex-basis: 100%; }
.yc-screen-error { width: min(384px, 100% - 32px); margin: 96px auto 48px; }
.yc-screen-error > .yc-notice__actions { flex-direction: column; align-items: stretch; }
.yc-screen-error > .yc-notice__actions > * { width: 100%; }

/* Loading line — ui/states.tsx LoadingState: the braille spinner, then "Loading …" in grey,
   centred with room above and below (--inline: small, at the left, inside a section). The spinner
   is the app's BrailleSpinner — the same ten frames every 80ms and the same colour cycle — in CSS
   only, so a page needs no script for it. WHY steps(): performance rule 6, an infinite animation
   presents only the frames that change. */
.yc-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 32px 0; font-size: 14px; color: var(--fg-muted); }
.yc-loading--inline { justify-content: flex-start; padding: 0 4px; font-size: 11px; }
.yc-loading::before { content: '⠋'; display: inline-block; flex: none; width: 1em; text-align: center; line-height: 1; animation: yc-spin 800ms steps(1, end) infinite, yc-spin-hue 3000ms steps(1, end) infinite; }
@keyframes yc-spin { 0% { content: '⠋'; } 10% { content: '⠙'; } 20% { content: '⠹'; } 30% { content: '⠸'; } 40% { content: '⠼'; } 50% { content: '⠴'; } 60% { content: '⠦'; } 70% { content: '⠧'; } 80% { content: '⠇'; } 90% { content: '⠏'; } 100% { content: '⠋'; } }
@keyframes yc-spin-hue { 0% { color: var(--fg-dim); } 20% { color: var(--fg-2); } 40% { color: var(--accent); } 60% { color: var(--fg-muted); } 80% { color: var(--fg-muted); } 100% { color: var(--fg-dim); } }

/* On/off switch — ui/Toggle.tsx: the 36×20 track, a 16px white knob ringed in edge-dim, accent
   when on, the border kept (transparent) when on so the knob never shifts. Write
   <button class="yc-switch" role="switch" aria-checked="false" aria-label="…"></button>;
   PAGE_KIT_JS flips aria-checked on a click, Space or Enter and fires "change". A plain
   <input type="checkbox" class="yc-switch"> draws the same and works natively. */
.yc-switch {
  -webkit-appearance: none; appearance: none; position: relative; display: inline-block; flex: none;
  vertical-align: middle; width: 36px; height: 20px; margin: 0; padding: 0; font: inherit;
  background: var(--inset); border: 1px solid var(--edge-dim); border-radius: var(--radius-full, 9999px);
  cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease;
}
.yc-switch::before {
  content: ''; position: absolute; top: 50%; left: 1px; width: 16px; height: 16px; transform: translateY(-50%);
  border-radius: 50%; background: #fff; border: 1px solid var(--edge-dim);
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1); transition: left 150ms ease;
}
.yc-switch[aria-checked="true"], .yc-switch:checked { background: var(--accent); border-color: transparent; }
.yc-switch--danger[aria-checked="true"], .yc-switch--danger:checked { background: var(--destructive); }
.yc-switch[aria-checked="true"]::before, .yc-switch:checked::before { left: 17px; }
.yc-switch:disabled, .yc-switch[aria-disabled="true"] { opacity: .6; cursor: not-allowed; }
.yc-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* The app's coarse-hit: a 44px invisible target on a touchscreen, no visual change. */
@media (pointer: coarse) { .yc-switch::after { content: ''; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 100%; height: 100%; min-width: 44px; min-height: 44px; } }

/* Search box + filter chips — ui/SearchFilterPill.tsx and ui/FilterChip.tsx: the inset box with
   the search glyph, the theme's control corner, the accent border while typing; chips inset with
   the edge outline, filled with the accent when on (aria-pressed="true" or .yc-filter--on).
   WHY one fixed height for both (guide principle 6; Destin gt-r2#C-5a: chips beside a box were too
   tight): controls on one line share one height, and 32px leaves the chip's words 6px above and
   below. */
.yc-search {
  display: flex; align-items: center; gap: 8px; height: 32px; min-width: 0; padding: 0 12px;
  color: var(--fg-muted); background: var(--inset); border: 1px solid var(--edge); border-radius: var(--yc-radius-control);
}
.yc-search::before { content: ''; flex: none; width: 15px; height: 15px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E") center / contain no-repeat; }
.yc-search:focus-within { border-color: var(--accent); }
.yc-search input { flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0; border: 0; outline: 0; background: transparent; font: inherit; font-size: 13px; color: var(--fg); }
.yc-search input::placeholder { color: var(--fg-muted); }
.yc-search input::-webkit-search-cancel-button { -webkit-appearance: none; }
.yc-filter {
  -webkit-appearance: none; appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none;
  height: 32px; margin: 0; padding: 0 12px; font: inherit; font-size: 14px; line-height: 20px; white-space: nowrap;
  color: var(--fg-2); background: var(--inset); border: 1px solid var(--edge); border-radius: var(--yc-radius-control);
  cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
}
.yc-filter:hover { color: var(--fg); border-color: var(--edge-dim); }
.yc-filter[aria-pressed="true"], .yc-filter[aria-checked="true"], .yc-filter--on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.yc-filter:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* One line of chips — the app's fact-chip row (marketplace/FactChips.tsx) and its chip (ui/Chip.tsx).
   WHY it never wraps (guide "Cards", principle 8): it scrolls sideways under the edge fade, with no
   scrollbar and 4px of room above and below so a chip's border is never cut. Filter chips
   (.yc-filter) go in one too. */
.yc-chips { display: flex; align-items: center; flex-wrap: nowrap; gap: 6px; min-width: 0; overflow-x: auto; overflow-y: hidden; padding: 4px 0; margin: -4px 0; scrollbar-width: none; }
.yc-chips::-webkit-scrollbar { display: none; }
.yc-chips > * { flex-shrink: 0; }
.yc-row > .yc-chips { flex: 1 1 auto; }
.yc-chips .yc-chip { gap: 4px; padding: 2px 6px; font-weight: 400; white-space: nowrap; }

/* Fold-out row — ui/FoldRow.tsx: a boxed row like a setting (the app's first-level box: inset at
   half, the card outline, the large corner), its title and grey hint at the left, the arrow at the
   right turning down when open. Write <details class="yc-fold"><summary>Title <span
   class="yc-fold__hint">hint</span></summary>…</details>: what it reveals opens INSIDE the same box,
   and pointing at it lights the WHOLE box in its own rounded shape (guide "Settings"). WHY native
   <details>: it opens and closes from the keyboard and to a screen reader with no script. */
.yc-fold, .yc-section { --yc-fold-arrow: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 5l7 7-7 7'/%3E%3C/svg%3E"); }
.yc-fold { background: color-mix(in oklab, var(--inset) 50%, transparent); border: 1px solid var(--yc-edge-card); border-radius: var(--radius-lg, 12px); transition: background-color 150ms steps(4); }
.yc-fold:has(> summary:hover) { background: var(--inset); }
.yc-fold > summary { position: relative; display: block; padding: 8px 40px 8px 12px; font-size: 12px; font-weight: 500; color: var(--fg); list-style: none; cursor: pointer; user-select: none; border-radius: inherit; }
.yc-fold > summary::-webkit-details-marker { display: none; }
.yc-fold > summary::after { content: ''; position: absolute; right: 12px; top: 50%; width: 16px; height: 16px; margin-top: -8px; background: var(--fg-muted); -webkit-mask: var(--yc-fold-arrow) center / contain no-repeat; mask: var(--yc-fold-arrow) center / contain no-repeat; transition: transform 150ms ease; }
.yc-fold[open] > summary::after { transform: rotate(90deg); }
.yc-fold > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.yc-fold__hint { display: block; margin-top: -2px; font-size: 11px; font-weight: 400; color: var(--fg-muted); }
.yc-fold > :not(summary) { margin-left: 12px; margin-right: 12px; }
.yc-fold > summary + * { margin-top: 4px; }
.yc-fold > :last-child:not(summary) { margin-bottom: 8px; }

/* A long section that folds at PHONE width only (guide principle 8, gt-r2#E-3b: the screen becomes
   a short list you open, the first one open). Write <details class="yc-section" open> on the first
   and <details class="yc-section"> on the rest, each starting with its <summary> heading. On a
   wider screen the heading is a plain Large heading and every section shows in full, whatever its
   open state; below 640px (the app's one breakpoint, 639.98px) each becomes a fold-out row. */
.yc-section > summary { list-style: none; margin-bottom: 8px; font-size: 16px; font-weight: 500; color: var(--fg); }
.yc-section > summary::-webkit-details-marker { display: none; }
@supports selector(::details-content) {
  @media not all and (max-width: 639.98px) {
    .yc-section::details-content { content-visibility: visible; }
    .yc-section > summary { pointer-events: none; }
  }
}
@media (max-width: 639.98px) {
  .yc-section { background: color-mix(in oklab, var(--inset) 50%, transparent); border: 1px solid var(--yc-edge-card); border-radius: var(--radius-lg, 12px); transition: background-color 150ms steps(4); }
  .yc-section:has(> summary:hover) { background: var(--inset); }
  .yc-section > summary { position: relative; margin: 0; padding: 8px 40px 8px 12px; font-size: 14px; cursor: pointer; user-select: none; border-radius: inherit; }
  .yc-section > summary::after { content: ''; position: absolute; right: 12px; top: 50%; width: 16px; height: 16px; margin-top: -8px; background: var(--fg-muted); -webkit-mask: var(--yc-fold-arrow) center / contain no-repeat; mask: var(--yc-fold-arrow) center / contain no-repeat; transition: transform 150ms ease; }
  .yc-section[open] > summary::after { transform: rotate(90deg); }
  .yc-section > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .yc-section > :not(summary) { margin-left: 12px; margin-right: 12px; }
  .yc-section > summary + * { margin-top: 4px; }
  .yc-section > :last-child:not(summary) { margin-bottom: 12px; }
}

/* The scroll fade — the app's ONE fade (styles/scroll-mask.css), mirrored rule for rule: the
   content fades to see-through at an edge only while more is hidden that way, followed by the
   browser itself (scroll-driven animations), no script per frame. The gradients and keyframes are
   the app's text exactly (pinned by tests/page-kit.test.ts); only the selectors differ.
   WHO gets it: the kit's own scrollers (.yc-app__main, .yc-sidebar, the dropdown's list, a chip
   row), anything marked .yc-scroll, and — automatically — every element a page makes scroll:
   PAGE_KIT_JS marks it .yc-scroll. The page document itself fades in the app's frame (the host
   draws the same fade on it). A page that wants none writes .yc-no-fade on the scroller. */
.yc-scroll, .yc-app__main, .yc-sidebar, .yc-menu__list, .yc-chips {
  --scroll-mask-size: 40px;
  --scroll-mask-under: 0px;
  --scroll-mask-over: 0px;
  --scroll-mask-start: 0px;
  --scroll-mask-t: 0;
  --scroll-mask-b: 0;
  --scroll-mask-l: 0;
  --scroll-mask-r: 0;
  --scroll-mask-on-y: initial;
  --scroll-mask-on-x: initial;
  --scroll-mask-on: var(--scroll-mask-on-y, var(--scroll-mask-on-x));
  --scroll-mask-s: min(var(--scroll-mask-size), 25%);
  --scroll-mask-y: linear-gradient(to bottom, #000 0, #000 var(--scroll-mask-over), transparent var(--scroll-mask-over), #000 calc(var(--scroll-mask-over) + var(--scroll-mask-t) * var(--scroll-mask-s) + var(--scroll-mask-on)), #000 calc(100% - var(--scroll-mask-under) - var(--scroll-mask-b) * var(--scroll-mask-s)), transparent calc(100% - var(--scroll-mask-under)));
  --scroll-mask-x: linear-gradient(to right, #000 0, #000 var(--scroll-mask-start), transparent var(--scroll-mask-start), #000 calc(var(--scroll-mask-start) + var(--scroll-mask-l) * var(--scroll-mask-s)), #000 calc(100% - var(--scroll-mask-r) * var(--scroll-mask-s)), transparent 100%);
  scroll-padding-block: var(--scroll-mask-s);
  -webkit-mask-image: var(--scroll-mask-y), var(--scroll-mask-x);
  mask-image: var(--scroll-mask-y), var(--scroll-mask-x);
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
}
/* The app's chip-row size (scroll-mask--chips): at 40px a chip-sized row loses most of its last chip. */
.yc-chips { --scroll-mask-size: 24px; }
@keyframes scroll-mask-top { from { --scroll-mask-t: 0; --scroll-mask-on-y: 0px; } to { --scroll-mask-t: 1; --scroll-mask-on-y: 0px; } }
@keyframes scroll-mask-bottom { from { --scroll-mask-b: 1; } to { --scroll-mask-b: 0; } }
@keyframes scroll-mask-left { from { --scroll-mask-l: 0; --scroll-mask-on-x: 0px; } to { --scroll-mask-l: 1; --scroll-mask-on-x: 0px; } }
@keyframes scroll-mask-right { from { --scroll-mask-r: 1; } to { --scroll-mask-r: 0; } }
@supports (animation-timeline: scroll()) {
  .yc-scroll, .yc-app__main, .yc-sidebar, .yc-menu__list {
    animation: scroll-mask-top linear both, scroll-mask-bottom linear both,
               scroll-mask-left linear both, scroll-mask-right linear both;
    animation-timeline: scroll(self block), scroll(self block),
                        scroll(self inline), scroll(self inline);
    animation-range: 0px 6px, calc(100% - 6px) 100%,
                     0px 6px, calc(100% - 6px) 100%;
  }
  /* A chip row only ever scrolls sideways: the app's one-way form (scroll-mask-x), half the cost. */
  .yc-chips {
    animation: scroll-mask-left linear both, scroll-mask-right linear both;
    animation-timeline: scroll(self inline), scroll(self inline);
    animation-range: 0px 6px, calc(100% - 6px) 100%;
  }
}
/* Without scroll-driven animations (an older browser), PAGE_KIT_JS sets these flags instead. */
@supports not (animation-timeline: scroll()) {
  [data-fade-top] { --scroll-mask-on-y: 0px; }
  [data-fade-top="true"] { --scroll-mask-t: 1; }
  [data-fade-bottom="true"] { --scroll-mask-b: 1; }
  [data-fade-left="true"] { --scroll-mask-l: 1; }
  [data-fade-right="true"] { --scroll-mask-r: 1; }
}
.yc-no-fade { -webkit-mask-image: none !important; mask-image: none !important; animation: none !important; }

@media (prefers-reduced-motion: reduce) {
  .yc-button, .yc-select, select.yc-menu, .yc-switch, .yc-switch::before, .yc-filter, .yc-fold, .yc-fold > summary::after, .yc-section, .yc-section > summary::after { transition: none; }
  .yc-loading::before { animation: none; }
}
`,Tn=`youcoded:edges`,En=`(function(){
  var open = null; // { sel, menu, list, items, active, ta, taAt, raf }
  var seq = 0;
  function single(sel) { return sel && sel.tagName === 'SELECT' && !sel.multiple && !(sel.size > 1); }
  function dispatch(sel, type) { sel.dispatchEvent(new Event(type, { bubbles: true })); }
  function setActive(i) {
    if (!open) return;
    var prev = open.items[open.active];
    if (prev) prev.el.removeAttribute('data-active');
    open.active = i;
    var it = open.items[i];
    if (!it) { open.sel.removeAttribute('aria-activedescendant'); return; }
    it.el.setAttribute('data-active', '');
    open.sel.setAttribute('aria-activedescendant', it.el.id);
    // Keep it in sight inside its own scroller (never scrollIntoView: that can scroll the page).
    var box = it.el.parentNode;
    if (box && box.className === 'yc-menu__list') {
      var top = it.el.offsetTop, bot = top + it.el.offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bot > box.scrollTop + box.clientHeight) box.scrollTop = bot - box.clientHeight;
    }
  }
  function step(from, dir) {
    var n = open.items.length;
    for (var k = 1; k <= n; k++) { var i = ((from + dir * k) % n + n) % n; if (!open.items[i].opt.disabled) return i; }
    return from;
  }
  function place() {
    if (!open) return;
    open.raf = 0;
    var r = open.sel.getBoundingClientRect(), m = open.menu, vw = window.innerWidth, vh = window.innerHeight;
    m.style.minWidth = Math.round(r.width) + 'px';
    m.style.maxHeight = 'none';
    var want = Math.min(m.scrollHeight, 320), below = vh - r.bottom - 12, above = r.top - 12;
    // WHY it can open upward: a page in a short pane often has its dropdown near the bottom.
    var up = want > below && above > below;
    var h = Math.max(80, Math.min(want, up ? above : below));
    m.style.maxHeight = h + 'px';
    m.style.top = (up ? Math.max(8, r.top - 4 - Math.min(want, h)) : r.bottom + 4) + 'px';
    m.style.left = Math.max(8, Math.min(r.left, vw - m.offsetWidth - 8)) + 'px';
  }
  function schedule() { if (open && !open.raf) open.raf = requestAnimationFrame(place); }
  function close(refocus) {
    if (!open) return;
    var o = open; open = null;
    if (o.raf) cancelAnimationFrame(o.raf);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    o.sel.removeEventListener('blur', onBlur);
    o.sel.removeAttribute('aria-expanded');
    o.sel.removeAttribute('aria-controls');
    o.sel.removeAttribute('aria-activedescendant');
    if (o.menu.parentNode) o.menu.parentNode.removeChild(o.menu);
    if (refocus) { try { o.sel.focus(); } catch (e) {} }
  }
  function onBlur() { close(false); }
  function choose(i) {
    if (!open) return;
    var it = open.items[i];
    if (!it || it.opt.disabled) return;
    var sel = open.sel;
    close(true);
    // The real select changes, and tells the page the way the browser would: input, then change.
    if (sel.selectedIndex !== it.opt.index) { sel.selectedIndex = it.opt.index; dispatch(sel, 'input'); dispatch(sel, 'change'); }
  }
  function row(opt, items) {
    var el = document.createElement('div');
    el.className = 'yc-menu__item';
    el.id = 'yc-menu-' + seq + '-' + items.length;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', opt.selected ? 'true' : 'false');
    if (opt.disabled) el.setAttribute('aria-disabled', 'true');
    el.textContent = opt.label || opt.text;
    el.setAttribute('data-index', String(items.length));
    items.push({ el: el, opt: opt });
    return el;
  }
  function openFor(sel) {
    close(false);
    seq++;
    var menu = document.createElement('div');
    menu.className = 'yc-menu';
    menu.id = 'yc-menu-' + seq;
    menu.setAttribute('role', 'listbox');
    if (sel.getAttribute('aria-label')) menu.setAttribute('aria-label', sel.getAttribute('aria-label'));
    var list = document.createElement('div');
    list.className = 'yc-menu__list';
    var foot = null, items = [], actions = [];
    for (var c = sel.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName === 'OPTGROUP') {
        var g = document.createElement('div');
        g.className = 'yc-menu__group'; g.setAttribute('role', 'presentation'); g.textContent = c.label;
        list.appendChild(g);
        for (var o = c.firstElementChild; o; o = o.nextElementSibling) if (o.tagName === 'OPTION' && !o.hidden) list.appendChild(row(o, items));
      } else if (c.tagName === 'OPTION' && !c.hidden) {
        if (c.hasAttribute('data-yc-action')) actions.push(c); else list.appendChild(row(c, items));
      }
    }
    menu.appendChild(list);
    if (actions.length) {
      foot = document.createElement('div');
      foot.className = 'yc-menu__foot';
      for (var fi = 0; fi < actions.length; fi++) foot.appendChild(row(actions[fi], items));
      menu.appendChild(foot);
    }
    (document.body || document.documentElement).appendChild(menu);
    open = { sel: sel, menu: menu, list: list, items: items, active: -1, ta: '', taAt: 0, raf: 0 };
    sel.setAttribute('aria-expanded', 'true');
    sel.setAttribute('aria-controls', menu.id);
    place();
    var cur = -1;
    for (var i = 0; i < items.length; i++) if (items[i].opt.selected) { cur = i; break; }
    setActive(cur >= 0 ? cur : step(-1, 1));
    // The pointer: hovering lights a row, a press keeps focus on the select, a click chooses.
    menu.addEventListener('mousedown', function (e) { e.preventDefault(); });
    menu.addEventListener('mousemove', function (e) {
      var t = e.target.closest ? e.target.closest('.yc-menu__item') : null;
      if (!t || !open) return;
      var n = +t.getAttribute('data-index');
      if (n !== open.active && !open.items[n].opt.disabled) setActive(n);
    });
    menu.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.yc-menu__item') : null;
      if (t) choose(+t.getAttribute('data-index'));
    });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    sel.addEventListener('blur', onBlur);
  }
  // A press on a select opens ours instead of the browser's; a press anywhere else closes it.
  window.addEventListener('mousedown', function (e) {
    var t = e.target;
    if (open && open.menu.contains(t)) return;
    var sel = t && t.closest ? t.closest('select') : null;
    if (!single(sel) || sel.disabled) { if (open) close(false); return; }
    if (e.button !== 0) return;
    e.preventDefault();
    if (open && open.sel === sel) { close(true); return; }
    try { sel.focus(); } catch (err) {}
    openFor(sel);
  }, true);
  // WHY on window, in the capture phase, registered before the page's own script runs: while
  // the list is open its keys belong to it alone, as they do to the browser's own list — the
  // page's shortcuts and the app's Escape (the bootstrap leaves the page on an Escape nobody
  // used) never see them.
  window.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!open) {
      if (!single(t) || t.disabled) return;
      var k0 = e.key;
      if (k0 === ' ' || k0 === 'Enter' || k0 === 'F4' || k0 === 'ArrowDown' || k0 === 'ArrowUp') {
        e.preventDefault(); e.stopImmediatePropagation();
        openFor(t);
      }
      return;
    }
    var k = e.key;
    if (k === 'Tab') { close(false); return; }
    e.stopImmediatePropagation();
    if (k === 'Escape') { e.preventDefault(); close(true); return; }
    if (k === 'ArrowDown') { e.preventDefault(); setActive(step(open.active, 1)); return; }
    if (k === 'ArrowUp') { e.preventDefault(); setActive(step(open.active < 0 ? 0 : open.active, -1)); return; }
    if (k === 'Home') { e.preventDefault(); setActive(step(-1, 1)); return; }
    if (k === 'End') { e.preventDefault(); setActive(step(0, -1)); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(open.active); return; }
    if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // First letters jump, as in the app's Select: keys within half a second add up ("mo").
      e.preventDefault();
      var now = Date.now();
      open.ta = now - open.taAt < 500 ? open.ta + k.toLowerCase() : k.toLowerCase();
      open.taAt = now;
      for (var i = 0; i < open.items.length; i++) {
        var it = open.items[i];
        if (!it.opt.disabled && (it.opt.label || it.opt.text).toLowerCase().indexOf(open.ta) === 0) { setActive(i); break; }
      }
      return;
    }
    e.preventDefault();
  }, true);
})();
(function(){
  // ── The switch (.yc-switch) ── the app's Toggle: a click, Space or Enter flips aria-checked and
  // fires "change", so page code reads el.getAttribute('aria-checked') === 'true' in its handler.
  // WHY in the capture phase on window: the flip happens before the page's own click handler runs,
  // so a page listening for "click" reads the new state too. WHY the kit handles Space and Enter
  // itself (and cancels the browser's): one path for a button and for a span or div a page made a
  // switch, and no double flip from the browser's own key-to-click.
  function sw(t) { var el = t && t.closest ? t.closest('.yc-switch') : null; return el && el.tagName !== 'INPUT' ? el : null; }
  function prep(el) {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'switch');
    if (!el.hasAttribute('aria-checked')) el.setAttribute('aria-checked', 'false');
    if (el.tagName !== 'BUTTON' && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  }
  function flip(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    prep(el);
    el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  window.addEventListener('click', function (e) { var el = sw(e.target); if (el) flip(el); }, true);
  window.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    var el = sw(e.target);
    if (!el || el !== e.target) return;
    e.preventDefault();
    if (!e.repeat) flip(el);
  }, true);
  window.addEventListener('keyup', function (e) { if (e.key === ' ' && sw(e.target) === e.target) e.preventDefault(); }, true);

  // ── The scroll fade (.yc-scroll) ── every element a page makes scroll gets the app's one fade
  // without the page asking: a scroller (overflow auto/scroll, from any stylesheet or style
  // attribute) is marked .yc-scroll, and the kit's CSS does the rest — it draws nothing while the
  // box fits. Cost (performance rules 2, 6, 8): one pass over the page when it is ready; after that
  // only ADDED elements are looked at, once per frame at most and only in a frame where something
  // was added; a class a page's redraw strips is put back in the same task, before paint (no
  // flicker); one passive scroll listener marks a scroller the passes missed the first time it
  // moves. No timers, nothing per frame while the page is still.
  var FADED = '.yc-scroll, .yc-app__main, .yc-sidebar, .yc-menu__list, .yc-chips';
  var timeline = !!(window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()'));
  function scrolls(v) { return v === 'auto' || v === 'scroll'; }
  function edges(el) {
    // Only without scroll-driven animations: the flags the kit's fallback CSS reads.
    var t = el.scrollTop > 3, b = el.scrollTop + el.clientHeight < el.scrollHeight - 3;
    var l = el.scrollLeft > 3, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 3;
    var v = [t, b, l, r], n = ['data-fade-top', 'data-fade-bottom', 'data-fade-left', 'data-fade-right'];
    for (var i = 0; i < 4; i++) if (el.getAttribute(n[i]) !== String(v[i])) el.setAttribute(n[i], String(v[i]));
  }
  function look(el) {
    if (el.nodeType !== 1 || el === document.documentElement) return;
    var c = el.classList;
    if (c.contains('yc-switch') && el.tagName !== 'INPUT') prep(el);
    if (c.contains('yc-scroll') || c.contains('yc-no-fade') || el.matches(FADED)) return;
    var s = getComputedStyle(el);
    if (scrolls(s.overflowY) || scrolls(s.overflowX)) { c.add('yc-scroll'); if (!timeline) edges(el); }
  }
  function lookAll(root) {
    look(root);
    var els = root.getElementsByTagName ? root.getElementsByTagName('*') : [];
    for (var i = 0; i < els.length; i++) look(els[i]);
  }
  var queue = [], raf = 0;
  function drain() {
    raf = 0;
    var list = queue; queue = [];
    for (var i = 0; i < list.length; i++) if (list[i].isConnected) lookAll(list[i]);
    if (!timeline) { var f = document.querySelectorAll(FADED); for (var j = 0; j < f.length; j++) edges(f[j]); }
    docSoon();
  }
  var mo = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'attributes') {
        // A redraw that rewrote the class dropped the mark: put it straight back (still this task).
        var el = r.target;
        if (r.oldValue && /(^|\\s)yc-scroll(\\s|$)/.test(r.oldValue) && !el.classList.contains('yc-scroll')) el.classList.add('yc-scroll');
        continue;
      }
      for (var k = 0; k < r.addedNodes.length; k++) if (r.addedNodes[k].nodeType === 1) queue.push(r.addedNodes[k]);
    }
    if (queue.length && !raf) raf = requestAnimationFrame(drain);
    else docSoon();
  });
  window.addEventListener('scroll', function (e) {
    var el = e.target;
    if (el && el.nodeType === 1) {
      if (!el.classList.contains('yc-scroll') && !el.classList.contains('yc-no-fade') && el !== document.documentElement && el !== document.body && !el.matches(FADED)) el.classList.add('yc-scroll');
      if (!timeline && el.matches(FADED)) edges(el);
    } else docSoon();
  }, { capture: true, passive: true });

  // ── The page document's own fade ── the document scrolls inside the app's frame, and a mask on
  // the document cannot follow it (a root mask scrolls away with the page), so the page tells the
  // app which edges hide more and the APP fades the frame with its one fade (PageHost,
  // scroll-mask.css .scroll-mask-frame). Read at most once a frame, posted only when it changes.
  var docT = null, docB = null, dRaf = 0;
  function docEdges() {
    dRaf = 0;
    var se = document.scrollingElement || document.documentElement;
    var t = se.scrollTop > 3, b = se.scrollTop + se.clientHeight < se.scrollHeight - 3;
    if (t === docT && b === docB) return;
    docT = t; docB = b;
    try { parent.postMessage({ type: ${JSON.stringify(Tn)}, top: t, bottom: b }, '*'); } catch (err) {}
  }
  function docSoon() { if (!dRaf) dRaf = requestAnimationFrame(docEdges); }
  window.addEventListener('resize', function () { docSoon(); if (!timeline && !raf) raf = requestAnimationFrame(drain); }, { passive: true });
  window.addEventListener('load', docSoon);
  // A fold opening changes the page's height without adding anything ("toggle" does not bubble).
  document.addEventListener('toggle', docSoon, true);

  function start() {
    lookAll(document.body || document.documentElement);
    if (!timeline) { var f = document.querySelectorAll(FADED); for (var j = 0; j < f.length; j++) edges(f[j]); }
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    docSoon();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`}));function On(e=document.documentElement,t=document.body){let n=t.getAttribute(`data-chrome-style`);return e.hasAttribute(`data-wallpaper`)&&!e.hasAttribute(`data-pages-solid`)&&(n===`floating`||n===`float`)}function kn(e=document.documentElement,t=!1){let n=getComputedStyle(e),r=[];for(let e of Ln){let t=n.getPropertyValue(`--${e}`).trim();t&&r.push(`--${e}: ${t};`)}if(t){let e=Number.parseFloat(n.getPropertyValue(`--panels-opacity`));r.push(`--panels-opacity: ${Number.isFinite(e)?e:1};`)}let i=n.getPropertyValue(`color-scheme`).trim()||n.colorScheme;return i&&r.push(`color-scheme: ${i};`),`:root { ${r.join(` `)} }`}function An(e,t=`{}`,n=!1,r=`none`,i=[]){return`(function(){
  var ID = ${JSON.stringify(sr)};
  var THEME = ${JSON.stringify(Rn)};
  var SET = ${JSON.stringify(zn)};
  var ESC = ${JSON.stringify(Bn)};
  var DATA = ${JSON.stringify(Vn)};
  var REFRESH = ${JSON.stringify(Hn)};
  var FETCH = ${JSON.stringify(Un)};
  var RESULT = ${JSON.stringify(Wn)};
  var PLAID = ${JSON.stringify(Gn)};
  var PLAID_RESULT = ${JSON.stringify(Kn)};
  var S_OPEN = ${JSON.stringify(qn)};
  var S_SEND = ${JSON.stringify(Jn)};
  var S_CLOSE = ${JSON.stringify(Yn)};
  var S_EVENT = ${JSON.stringify(Xn)};
  var V_START = ${JSON.stringify(Zn)};
  var V_STOP = ${JSON.stringify(Qn)};
  var V_ACK = ${JSON.stringify($n)};
  var V_EVENT = ${JSON.stringify(er)};
  var SESSION = ${JSON.stringify(tr)};
  var SESSION_RESULT = ${JSON.stringify(nr)};
  var MAX_PROMPT = ${Ge};
  var HIDDEN = new RegExp(${JSON.stringify(tt.source)}, 'u');
  var REFUSED = ${JSON.stringify(ct)};
  var CHATS = ${JSON.stringify(rr)};
  var CHATS_RESULT = ${JSON.stringify(ir)};
  var CHATS_REFUSED = ${JSON.stringify(R)};
  var PROGRAM = ${JSON.stringify(ar)};
  var PROGRAM_RESULT = ${JSON.stringify(or)};
  var PROGRAM_REFUSED = ${JSON.stringify(Oe)};
  var PROGRAM_FILES = ${JSON.stringify(i)};
  var MAX_PROGRAM_INPUT = ${Pe};
  var videos = {};
  var videoSeq = 0;
  var sockets = {};
  var socketSeq = 0;
  var subs = [];
  var refreshSubs = [];
  var waiting = {};
  var seq = 0;
  function call(list, arg) {
    for (var i = 0; i < list.length; i++) { try { list[i](arg); } catch (err) {} }
  }
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    // WHY wait one tick: a page's own Escape handler (closing its pop-up) may be registered after this one, so it has not run yet.
    // If it called preventDefault (or stopped the key before it got here) the page used the key, and the app must not ALSO leave the
    // view (ux review 2, U1). A page that ignores Escape still leaves as before.
    setTimeout(function () {
      if (e.defaultPrevented) return;
      try { parent.postMessage({ type: ESC }, '*'); } catch (err) {}
    }, 0);
  });
  window.youcoded = {
    data: ${e},
    // Home-device deck, Q-address: the page suggested an address but the
    // person may have allowed another, so the page asks here where its device
    // is. Only ALLOWED devices appear; a page waiting for a yes sees none.
    devices: ${t},
    save: function (data) { window.youcoded.data = data; try { parent.postMessage({ type: SET, data: data }, '*'); } catch (e) {} },
    onData: function (cb) { if (typeof cb === 'function') subs.push(cb); },
    onRefresh: function (cb) { if (typeof cb === 'function') refreshSubs.push(cb); },
    // A live connection to the page's approved home device. The host owns the
    // real one; this is a handle. Every 'open' is a fresh connection: wait for
    // the device's own "logged in" reply in onMessages before subscribing, and
    // subscribe again after every 'open'. send() is refused unless 'open'.
    socket: function (url, opts) {
      var o = opts || {};
      var id = 's' + (++socketSeq);
      var rec = { state: 'connecting', onState: o.onState, onMessages: o.onMessages };
      sockets[id] = rec;
      try { parent.postMessage({ type: S_OPEN, id: id, url: String(url) }, '*'); }
      catch (e) { rec.state = 'closed'; delete sockets[id]; }
      return {
        send: function (text) {
          if (rec.state !== 'open' || typeof text !== 'string') return false;
          try { parent.postMessage({ type: S_SEND, id: id, text: text }, '*'); return true; } catch (e) { return false; }
        },
        close: function () {
          if (!sockets[id]) return;
          delete sockets[id];
          rec.state = 'closed';
          try { parent.postMessage({ type: S_CLOSE, id: id }, '*'); } catch (e) {}
        }
      };
    },
    // Live camera video, played by the app: the page names a device connection and
    // a camera, and gets PICTURES (ImageBitmaps) — never an address or a stream.
    // onFrame(bitmap, ack): draw it on a canvas, then call ack() to ask for the next.
    // onState('starting' | 'playing' | 'stopped', why). stop() ends it.
    video: function (connection, target, opts) {
      var o = opts || {};
      var id = 'v' + (++videoSeq);
      var rec = { state: 'starting', onFrame: o.onFrame, onState: o.onState };
      videos[id] = rec;
      try { parent.postMessage({ type: V_START, id: id, connection: String(connection), target: String(target) }, '*'); }
      catch (e) { rec.state = 'stopped'; delete videos[id]; }
      return {
        stop: function () {
          if (!videos[id]) return;
          delete videos[id];
          rec.state = 'stopped';
          try { parent.postMessage({ type: V_STOP, id: id }, '*'); } catch (e) {}
        }
      };
    },
    // Bank balances through Plaid, done by the app (main/pages/plaid.ts). Ask for
    // { op: 'status' | 'connect' | 'accounts' (live?) | 'reconnect' | 'remove' (itemId) }.
    // Always resolves with { ok, op, items } or { ok: false, op, code, message }.
    plaid: function (request) {
      return new Promise(function (resolve) {
        var id = 'p' + (++seq);
        waiting[id] = { resolve: resolve, reject: resolve, plaid: true };
        try { parent.postMessage({ type: PLAID, id: id, request: request }, '*'); }
        catch (e) { delete waiting[id]; resolve({ ok: false, op: request && request.op, code: 'UNAVAILABLE', message: 'This page could not reach YouCoded.' }); }
      });
    },
    fetch: function (url, opts) {
      return new Promise(function (resolve, reject) {
        var o = opts || {};
        var id = 'f' + (++seq);
        waiting[id] = { resolve: resolve, reject: reject };
        try {
          parent.postMessage({
            type: FETCH, id: id, url: String(url),
            method: o.method, headers: o.headers, body: o.body, as: o.as, socket: o.socket
          }, '*');
        } catch (e) {
          delete waiting[id];
          reject(new Error('This page could not reach YouCoded.'));
        }
      });
    }
  };
  // Page start session (spec 2026-10-14, §2). WHY only when declared: a page
  // feature-detects it (typeof … === 'function') and keeps its own fallback —
  // Frontier Lab's copy box — on an app or a manifest without it. Always
  // resolves { ok }; an empty or runaway message never reaches the host. The
  // host checks all of this again, because page code can post on its own.
  // A refusal carries a plain reason for the page's author (review F1/F2).
  if (${n?`true`:`false`}) {
    window.youcoded.startSession = function (opts) {
      return new Promise(function (resolve) {
        var o = opts || {};
        var prompt = o.prompt;
        var no = function (reason) { resolve({ ok: false, reason: reason }); };
        // WHY a real click (review F2, Destin chose no rate limits): only a
        // press inside the page may open the window, so a page cannot open it
        // on a timer or reopen it straight after Cancel — the same "you press
        // it yourself" the Start button already asks for. The browser sets
        // this; page code cannot fake it. An engine without it counts as no click.
        var ua = window.navigator && window.navigator.userActivation;
        if (!ua || !ua.isActive) { no(REFUSED.noClick); return; }
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) { no(REFUSED.badMessage); return; }
        if (HIDDEN.test(prompt)) { no(REFUSED.hidden); return; }
        var id = 'n' + (++seq);
        waiting[id] = { resolve: resolve, reject: resolve, session: true };
        var msg = { type: SESSION, id: id, prompt: prompt };
        if (typeof o.project === 'string' && o.project) msg.project = o.project;
        try { parent.postMessage(msg, '*'); }
        catch (e) { delete waiting[id]; no(REFUSED.closed); }
      });
    };
  }
  // Page chats (spec 2026-10-16). WHY only when approved: a page feature-detects it (youcoded.chats) and keeps its
  // own fallback on an app or a manifest without it. Always resolves { ok, ... }; the host checks the approval,
  // the scope and the click again, because page code can post on its own. Reading and opening need a lookup
  // line; setTag / setNote / setMark exist only with access "full".
  if (${r===`none`?`false`:`true`}) {
    var chatCall = function (request, needsClick) {
      return new Promise(function (resolve) {
        var no = function (reason) { resolve({ ok: false, reason: reason }); };
        if (needsClick) {
          // WHY a real click: a page cannot open a chat on a timer (the same rule as startSession).
          var ua = window.navigator && window.navigator.userActivation;
          if (!ua || !ua.isActive) { no(CHATS_REFUSED.noClick); return; }
        }
        var id = 'c' + (++seq);
        waiting[id] = { resolve: resolve, reject: resolve, chats: true };
        try { parent.postMessage({ type: CHATS, id: id, request: request }, '*'); }
        catch (e) { delete waiting[id]; no(CHATS_REFUSED.closed); }
      });
    };
    window.youcoded.chats = {
      list: function () { return chatCall({ op: 'list' }, false); },
      resume: function (chat) { return chatCall({ op: 'resume', chat: String(chat) }, true); }
    };
    if (${r===`full`?`true`:`false`}) {
      window.youcoded.chats.setTag = function (chat, tag, on) { return chatCall({ op: 'setTag', chat: String(chat), tag: String(tag), on: !!on }, false); };
      window.youcoded.chats.setNote = function (chat, text) { return chatCall({ op: 'setNote', chat: String(chat), text: String(text) }, false); };
      window.youcoded.chats.setMark = function (chat, mark, on) { return chatCall({ op: 'setMark', chat: String(chat), mark: String(mark), on: !!on }, false); };
    }
  }
  // Page programs (spec 2026-10-16): only the files with an approved line. The host and main check again, and
  // main also checks that the file is still the one that was approved.
  if (PROGRAM_FILES.length) {
    window.youcoded.program = {
      run: function (file, input) {
        return new Promise(function (resolve) {
          var no = function (reason) { resolve({ ok: false, reason: reason }); };
          if (typeof file !== 'string' || PROGRAM_FILES.indexOf(file) < 0) { no(PROGRAM_REFUSED.notAllowed); return; }
          var text = input === undefined ? '' : input;
          if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_PROGRAM_INPUT) { no(PROGRAM_REFUSED.badRequest); return; }
          var id = 'g' + (++seq);
          waiting[id] = { resolve: resolve, reject: resolve, program: true };
          try { parent.postMessage({ type: PROGRAM, id: id, file: file, input: text }, '*'); }
          catch (e) { delete waiting[id]; no(PROGRAM_REFUSED.closed); }
        });
      }
    };
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e && e.data;
    if (!d) return;
    if (d.type === THEME && typeof d.css === 'string') {
      var el = document.getElementById(ID);
      if (!el) { el = document.createElement('style'); el.id = ID; document.head.appendChild(el); }
      el.textContent = d.css;
      // The host says whether the app's pane behind this page is glass (and the
      // person has not switched it off): the page turns see-through with it, live.
      document.documentElement.toggleAttribute(${JSON.stringify(cr)}, d.seeThrough === true);
      return;
    }
    if (d.type === S_EVENT && typeof d.id === 'string') {
      // Matched by this page's own id: a forged event for an id it never made resolves nothing.
      var sr = sockets[d.id];
      if (!sr) return;
      if (d.kind === 'state' && typeof d.state === 'string') {
        sr.state = d.state;
        if (d.state === 'closed') delete sockets[d.id];
        if (typeof sr.onState === 'function') { try { sr.onState(d.state, typeof d.why === 'string' ? d.why : undefined); } catch (err) {} }
      } else if (d.kind === 'messages' && Array.isArray(d.texts) && typeof sr.onMessages === 'function') {
        try { sr.onMessages(d.texts.filter(function (t) { return typeof t === 'string'; })); } catch (err) {}
      }
      return;
    }
    if (d.type === V_EVENT && typeof d.id === 'string') {
      // Matched by this page's own id: a forged event for an id it never made resolves nothing.
      var vr = videos[d.id];
      if (!vr) { if (d.bitmap && typeof d.bitmap.close === 'function') { try { d.bitmap.close(); } catch (err) {} } return; }
      if (d.kind === 'state' && typeof d.state === 'string') {
        vr.state = d.state;
        if (d.state === 'stopped') delete videos[d.id];
        if (typeof vr.onState === 'function') { try { vr.onState(d.state, typeof d.why === 'string' ? d.why : undefined); } catch (err) {} }
      } else if (d.kind === 'frame' && d.bitmap) {
        var vn = d.n, finished = false;
        var release = function () { if (finished) return; finished = true; try { parent.postMessage({ type: V_ACK, id: d.id, n: vn }, '*'); } catch (err) {} };
        if (typeof vr.onFrame === 'function') { try { vr.onFrame(d.bitmap, release); } catch (err) { release(); } }
        else { try { d.bitmap.close(); } catch (err) {} release(); }
      }
      return;
    }
    if (d.type === DATA) { window.youcoded.data = d.data; call(subs, d.data); return; }
    if (d.type === REFRESH) { call(refreshSubs); return; }
    if (d.type === SESSION_RESULT) {
      // Matched by this page's own id, like every other answer.
      var sp = waiting[d.id];
      if (!sp || !sp.session) return;
      delete waiting[d.id];
      var ok = !!(d.result && d.result.ok === true);
      sp.resolve(ok ? { ok: true } : { ok: false, reason: d.result && typeof d.result.reason === 'string' ? d.result.reason : REFUSED.closed });
      return;
    }
    if (d.type === CHATS_RESULT || d.type === PROGRAM_RESULT) {
      // Matched by this page's own id AND by kind, so a forged answer cannot settle a different call.
      var cw = waiting[d.id];
      if (!cw || !(d.type === CHATS_RESULT ? cw.chats : cw.program)) return;
      delete waiting[d.id];
      cw.resolve(d.result && typeof d.result === 'object' && typeof d.result.ok === 'boolean' ? d.result : { ok: false, reason: CHATS_REFUSED.badRequest });
      return;
    }
    if (d.type === PLAID_RESULT) {
      var pp = waiting[d.id];
      if (!pp || !pp.plaid) return;
      delete waiting[d.id];
      pp.resolve(d.result);
      return;
    }
    if (d.type === RESULT) {
      var p = waiting[d.id];
      // A fetch answer never settles a startSession call (it would resolve with a fetch's shape).
      if (!p || p.session || p.chats || p.program) return;
      delete waiting[d.id];
      var r = d.result;
      if (r && r.ok) p.resolve({ status: r.status, headers: r.headers, body: r.body });
      else p.reject(new Error((r && r.message) || 'The request was refused.'));
    }
  });
})();`}function jn(e){let t=e.some(e=>e.kind===`open`),n=e.some(e=>e.kind===`device`);return[`default-src 'none'`,`connect-src 'none'`,`script-src 'unsafe-inline'`,`style-src 'unsafe-inline'`,`img-src data: blob:${t?` https:`:``}`,`font-src data:${t?` https:`:``}`,...t||n?[`media-src ${[n?`data:`:``,t?`https:`:``].filter(Boolean).join(` `)}`]:[],`form-action 'none'`,`base-uri 'none'`,`frame-src 'none'`,`webrtc 'block'`].join(`; `)}function Mn(e){let t=e.toLowerCase(),n=[],r=0,i=0;for(;i<e.length;){let a=e.indexOf(`<`,i);if(a<0)break;if(t.startsWith(`<!--`,a)){let n=t.indexOf(`-->`,a+4);i=n<0?e.length:n+3;continue}if(t.startsWith(`<!`,a)||t.startsWith(`<?`,a)){let n=e.indexOf(`>`,a+2),o=n<0?e.length:n+1;t.startsWith(`<!doctype`,a)&&e.slice(0,a).trim()===``&&(r=o),i=o;continue}let o=/^<(\/?)([a-z][a-z0-9]*)/.exec(t.slice(a,a+40));if(!o){i=a+1;continue}let s=o[1]===`/`,c=o[2],l=a+o[0].length,u=``,d=-1;for(;l<e.length;l++){let t=e[l];if(u)t===u&&(u=``);else if(t===`"`||t===`'`)u=t;else if(t===`>`){d=l;break}}let f=d<0?e.length:d+1;if(ur.has(c)){let t=s||d<0?``:e.slice(a+o[0].length,d).replace(/\/\s*$/,``).trim();n.push({name:c,close:s,start:a,end:f,attrs:t})}if(i=f,!s&&lr.has(c)){let n=t.indexOf(`</${c}`,i);i=n<0?e.length:n}}return{tags:n,doctypeEnd:r}}function Nn(e,t,n,r){let i=``,a=t;for(let o of r){if(o.end<=t||o.start>=n)continue;let r=Math.max(o.start,t);r>a&&(i+=e.slice(a,r)),a=Math.max(a,Math.min(o.end,n))}return i+e.slice(a,n)}function Pn(e){let{tags:t,doctypeEnd:n}=Mn(e),r=(e,n)=>t.find(t=>t.name===e&&t.close===n)??null,i=r(`html`,!1),a=r(`head`,!1),o=r(`head`,!0),s=r(`body`,!1),c=-1,l=-1,u=-1,d=-1;if(a){let e=o&&o.start>=a.end?o:s&&s.start>=a.end?s:null;e&&(c=a.end,l=e.start,u=a.start,d=e===o?e.end:e.start)}let f=t.map(e=>({start:e.start,end:e.end}));return n>0&&f.unshift({start:0,end:n}),f.sort((e,t)=>e.start-t.start),{head:c>=0?Nn(e,c,l,f):``,body:u>=0?Nn(e,0,u,f)+Nn(e,d,e.length,f):Nn(e,0,e.length,f),htmlAttrs:i?.attrs?` ${i.attrs}`:``,bodyAttrs:s?.attrs?` ${s.attrs}`:``}}function Fn(e,t,n,r=null,i=[],a=!1){let o=JSON.stringify(r??null).replace(/<\//g,`<\\/`),s={};for(let e of i)e.kind===`device`&&e.approved&&e.id&&e.address&&(s[e.id]=`http://${e.address}`);let c=JSON.stringify(s).replace(/<\//g,`<\\/`),l=i.find(e=>e.kind===`chats`&&e.approved),u=l?l.access===`full`?`full`:`lookup`:`none`,d=i.flatMap(e=>e.kind===`program`&&e.approved&&typeof e.file==`string`?[e.file]:[]),f=`<meta http-equiv="Content-Security-Policy" content="${jn(i)}"><meta http-equiv="x-dns-prefetch-control" content="off"><style id="${sr}">${t}</style><style id="youcoded-kit">${n}</style><script>${An(o,c,i.some(e=>e.kind===`session`&&e.approved),u,d)}<\/script><script id="youcoded-kit-js">${En}<\/script>`,p=Pn(e),m=a?` ${cr}`:``;return`<!doctype html><html${p.htmlAttrs}${m}><head>${f}${p.head}</head><body${p.bodyAttrs}>${p.body}</body></html>`}function In(e){let t=()=>{let e=On();return{css:kn(document.documentElement,e),see:e}},n=t(),r=new MutationObserver(()=>{let r=t();(r.css!==n.css||r.see!==n.see)&&(n=r,e(r.css,r.see))});return r.observe(document.documentElement,{attributes:!0}),r.observe(document.body,{attributes:!0}),()=>r.disconnect()}var Ln,Rn,zn,Bn,Vn,Hn,Un,Wn,Gn,Kn,qn,Jn,Yn,Xn,Zn,Qn,$n,er,tr,nr,rr,ir,ar,or,sr,cr,lr,ur,dr=t((()=>{Te(),Dn(),at(),Ln=`canvas.panel.inset.well.accent.on-accent.fg.fg-2.fg-dim.fg-muted.fg-faint.edge.edge-dim.link.link-hover.destructive.destructive-fg.on-destructive.warning-fg.tag-red.tag-orange.tag-amber.tag-green.tag-teal.tag-blue.tag-indigo.tag-purple.tag-pink.tag-gray.radius.radius-sm.radius-md.radius-lg.radius-xl.radius-full.font-sans.font-mono`.split(`.`),Rn=`youcoded:theme`,zn=`youcoded:data:set`,Bn=`youcoded:esc`,Vn=`youcoded:data`,Hn=`youcoded:refresh`,Un=`youcoded:fetch`,Wn=`youcoded:fetch:result`,Gn=`youcoded:plaid`,Kn=`youcoded:plaid:result`,qn=`youcoded:socket:open`,Jn=`youcoded:socket:send`,Yn=`youcoded:socket:close`,Xn=`youcoded:socket:event`,Zn=`youcoded:video:start`,Qn=`youcoded:video:stop`,$n=`youcoded:video:ack`,er=`youcoded:video:event`,tr=`youcoded:session:start`,nr=`youcoded:session:start:result`,rr=`youcoded:chats`,ir=`youcoded:chats:result`,ar=`youcoded:program`,or=`youcoded:program:result`,sr=`youcoded-theme`,cr=`data-yc-see-through`,lr=new Set([`script`,`style`,`textarea`,`title`,`xmp`,`noembed`,`noframes`,`noscript`,`iframe`]),ur=new Set([`html`,`head`,`body`])}));function fr(e){let t=typeof crypto<`u`&&`randomUUID`in crypto?crypto.randomUUID():`f${Math.random().toString(36).slice(2)}${Date.now()}`,n=new Map,r=new Map,i=e.isHidden??(()=>typeof document<`u`&&document.visibilityState===`hidden`),a=!1,o=null,s=null,c=new Map,l=0,u=()=>({page:e.pageId,frame:t}),d=(t,r,i)=>{let a=n.get(t);a&&(a.state=r),e.post({type:Xn,id:t,kind:`state`,state:r,...i?{why:i}:{}})},f=()=>{o!==null&&(clearInterval(o),o=null)},p=()=>{a||i()||![...n.values()].some(e=>e.mainId!==null)?f():o===null&&(o=setInterval(()=>{let t=e.bridge();for(let[i,o]of[...n])o.mainId!==null&&t?.socketPing?.({...u(),socket:o.mainId})?.then(t=>{t&&t.ok===!1&&n.get(i)===o&&o.mainId!==null&&!a&&(r.delete(o.mainId),o.mainId=null,o.state=`closed`,n.delete(i),p(),e.post({type:Xn,id:i,kind:`state`,state:`closed`,why:`The live connection ended.`}))}).catch(()=>{})},pr))},m=()=>{s||=e.bridge()?.onSocketEvent?.(e=>{if(a)return;let t=r.get(e?.socket);if(t)h(t,e);else if(l>0&&typeof e?.socket==`string`){let t=c.get(e.socket)??[];t.length<64&&c.size<16&&(t.push(e),c.set(e.socket,t))}})??null},h=(t,i)=>{let a=n.get(t);a&&(i.kind===`state`?(i.state===`closed`&&(r.delete(i.socket),a.mainId=null,a.state=`closed`,p()),d(t,i.state,i.why),i.state===`closed`&&n.delete(t)):i.kind===`messages`&&Array.isArray(i.texts)&&e.post({type:Xn,id:t,kind:`messages`,texts:i.texts}))},g=async(t,o=!1)=>{let s=n.get(t);if(!s)return;s.retryTimer!==null&&(clearTimeout(s.retryTimer),s.retryTimer=null);let f=e.bridge();if(!f?.socketOpen){d(t,`closed`,`This window cannot open live connections.`),n.delete(t);return}m();let _=++s.attempt;d(t,`connecting`);let v;l++;try{v=await f.socketOpen({...u(),url:s.url})}catch{v={ok:!1,message:`The live connection could not be started.`}}try{let e=n.get(t);if(a||!e||e.attempt!==_){v.ok&&f.socketClose?.({...u(),socket:v.socket})?.catch(()=>{});return}if(!v.ok){if(o&&++e.retries<=yr){d(t,`paused`,v.message),e.retryTimer=setTimeout(()=>{e.retryTimer=null,!a&&n.get(t)===e&&e.state===`paused`&&!i()&&g(t,!0)},vr);return}d(t,`closed`,v.message),n.delete(t);return}e.retries=0,e.mainId=v.socket,r.set(v.socket,t),p();let s=c.get(v.socket);c.delete(v.socket);for(let e of s??[])h(t,e)}finally{--l===0&&c.clear()}},_=t=>{let n=t.mainId;t.mainId=null,t.attempt++,t.retryTimer!==null&&(clearTimeout(t.retryTimer),t.retryTimer=null),n!==null&&(r.delete(n),e.bridge()?.socketClose?.({...u(),socket:n})?.catch(()=>{}))},v=()=>{if(!a){if(i())for(let[e,t]of n)t.state!==`closed`&&(_(t),d(e,`paused`,`The window is hidden.`));else for(let[e,t]of n)t.state===`paused`&&g(e,!0);p()}};return typeof document<`u`&&document.addEventListener(`visibilitychange`,v),{frame:t,handleFrameMessage(t){let r=t.type;if(r!==`youcoded:socket:open`&&r!==`youcoded:socket:send`&&r!==`youcoded:socket:close`)return!1;if(a)return!0;let o=t.id;if(typeof o!=`string`||!o||o.length>gr)return!0;if(r===`youcoded:socket:open`)return n.has(o)?!0:n.size>=_r?(d(o,`closed`,`A page may keep at most ${_r} live connections open.`),!0):typeof t.url!=`string`||t.url.length>hr?(d(o,`closed`,`That page asked for a live connection the app could not read.`),!0):(n.set(o,{url:t.url,mainId:null,state:`connecting`,attempt:0,retries:0,retryTimer:null}),i()?d(o,`paused`,`The window is hidden.`):g(o),!0);let s=n.get(o);return s?r===`youcoded:socket:close`?(n.delete(o),_(s),p(),!0):(s.state!==`open`||s.mainId===null||typeof t.text!=`string`||new TextEncoder().encode(t.text).length>mr||e.bridge()?.socketSend?.({...u(),socket:s.mainId,text:t.text})?.catch(()=>{}),!0):!0},dispose(){if(!a){a=!0;for(let[t,r]of n)r.state!==`closed`&&e.post({type:Xn,id:t,kind:`state`,state:`closed`,why:`This page is not on screen any more, so its live connection was closed.`});f(),typeof document<`u`&&document.removeEventListener(`visibilitychange`,v),s?.(),s=null;for(let e of n.values())_(e);n.clear(),r.clear()}}}}var pr,mr,hr,gr,_r,vr,yr,br=t((()=>{dr(),pr=2e4,mr=64e3,hr=2048,gr=64,_r=8,vr=15e3,yr=4}));function xr(){return{createPeer:()=>new RTCPeerConnection,createVideoEl:()=>{let e=document.createElement(`video`);return e.muted=!0,e.playsInline=!0,e.autoplay=!0,e.setAttribute(`aria-hidden`,`true`),e.style.cssText=`position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1`,document.body.appendChild(e),e},createBitmap:(e,t)=>t?createImageBitmap(e,t):createImageBitmap(e),createProcessor:e=>{let t=globalThis.MediaStreamTrackProcessor;if(!t)return null;let n=new t({track:e}).readable.getReader();return{read:()=>n.read(),cancel:()=>{n.cancel().catch(()=>{})}}}}}function Sr(e){let t={...xr(),...e.deps},n=new Map,r=new Map,i=e.isHidden??(()=>typeof document<`u`&&document.visibilityState===`hidden`),a=!1,o=0,s=new Map,c=null,l=null,u=t=>({page:e.pageId,frame:e.frame,video:t}),d=(t,r,i)=>{let a=n.get(t);a&&(a.state=r),e.post({type:er,id:t,kind:`state`,state:r,...i?{why:i}:{}})},f=()=>{a||i()||![...n.values()].some(e=>e.mainId!==null)?c!==null&&(clearInterval(c),c=null):c===null&&(c=setInterval(()=>{let t=e.bridge();for(let[e,r]of[...n])r.mainId!==null&&t?.videoPing?.(u(r.mainId))?.then(t=>{t&&t.ok===!1&&n.get(e)===r&&m(e,`The video stopped.`,{tellMain:!1,tellPage:!0})}).catch(()=>{})},Cr))},p=e=>{e.attempt++,e.stopPump?.(),e.stopPump=null;for(let t of Object.keys(e.timers))clearTimeout(e.timers[t]),clearInterval(e.timers[t]),e.timers[t]=void 0;try{e.pc?.close()}catch{}if(e.pc=null,e.el){try{e.el.srcObject=null}catch{}try{e.el.remove()}catch{}e.el=null}e.queued=[]},m=(t,i,a)=>{let o=n.get(t);if(!o)return;n.delete(t);let s=o.mainId;o.mainId=null,p(o),s!==null&&(r.delete(s),a.tellMain&&e.bridge()?.videoStop?.(u(s))?.catch(()=>{})),a.tellPage&&e.post({type:er,id:t,kind:`state`,state:`stopped`,...i?{why:i}:{}}),f()},h=async(r,i,o,s)=>{if(i.lastFrameAt=Date.now(),i.outstanding!==0||a||n.get(r)!==i||i.lastFrameAt-i.lastBitmapAt<Dr){s?.();return}i.lastBitmapAt=i.lastFrameAt;let c=++i.seq;i.outstanding=c;let l,u=o,f=u.videoWidth||u.displayWidth||u.codedWidth||0;try{l=await t.createBitmap(o,f>Or?{resizeWidth:Or,resizeQuality:`low`}:void 0)}catch{i.outstanding=0,s?.();return}if(s?.(),a||n.get(r)!==i||i.outstanding!==c){l.close(),i.outstanding===c&&(i.outstanding=0);return}i.state!==`playing`&&(d(r,`playing`),i.timers.quiet=setInterval(()=>{Date.now()-i.lastFrameAt>=15e3&&m(r,`The camera stopped sending pictures.`,{tellMain:!0,tellPage:!0})},1e3)),i.timers.nopic&&(clearTimeout(i.timers.nopic),i.timers.nopic=void 0);let p=!1;try{p=e.post({type:er,id:r,kind:`frame`,n:c,bitmap:l},[l])!==!1}catch{}p||(l.close(),i.outstanding=0)},g=(e,n,r)=>{let i=n.el;if(!i)return;let a=Date.now(),o=!1,s=!1,c=[];n.stopPump=()=>{o=!0;for(let e of c.splice(0))e()};let l=()=>{if(o||s)return;let t=i.requestVideoFrameCallback(()=>{a=Date.now(),h(e,n,i),l()});c[0]=()=>i.cancelVideoFrameCallback?.(t)},u=()=>{let i=t.createProcessor?.(r);return i?(s=!0,c.push(()=>i.cancel()),(async()=>{for(;!o;){let t;try{t=await i.read()}catch{break}if(t.done||!t.value)break;if(o){try{t.value.close()}catch{}break}let r=t.value;h(e,n,r,()=>r.close())}})(),!0):!1};typeof i.requestVideoFrameCallback==`function`?(l(),n.timers.stall=setInterval(()=>{s||o||Date.now()-a<Er||(c[0]?.(),u()||l())},1e3)):u()},_=e=>new Promise(t=>{if(e.iceGatheringState===`complete`){t();return}let n=()=>{clearTimeout(i),e.removeEventListener(`icegatheringstatechange`,r),t()},r=()=>{e.iceGatheringState===`complete`&&n()},i=setTimeout(n,wr);e.addEventListener(`icegatheringstatechange`,r)}),v=(e,t,n)=>{if(n.kind===`video-stopped`){m(e,n.why||`The video stopped.`,{tellMain:!1,tellPage:!0});return}let r=t.pc;if(!r)return;let i=t.attempt;if(n.kind===`video-answer`)r.setRemoteDescription({type:`answer`,sdp:n.answer}).then(async()=>{if(t.attempt!==i)return;t.remoteSet=!0;let e=t.queued;t.queued=[];for(let t of e)try{await r.addIceCandidate(t)}catch{}}).catch(()=>{t.attempt===i&&m(e,`The camera's answer could not be used.`,{tellMain:!0,tellPage:!0})});else if(n.kind===`video-candidate`){let e;try{e=JSON.parse(n.candidate)}catch{return}if(!t.remoteSet){t.queued.length<64&&t.queued.push(e);return}r.addIceCandidate(e).catch(()=>{})}},ee=()=>{l||=e.bridge()?.onSocketEvent?.(e=>{if(a||e?.kind!==`video-answer`&&e?.kind!==`video-candidate`&&e?.kind!==`video-stopped`)return;let t=r.get(e.socket);if(!t){if(o>0){let t=s.get(e.socket)??[];t.length<64&&s.size<16&&(t.push(e),s.set(e.socket,t))}return}let i=n.get(t);i&&v(t,i,e)})??null},y=async(i,c,l)=>{let p=n.get(i);if(!p)return;let h=e.bridge();if(!h?.videoStart){m(i,`This window cannot play camera video.`,{tellMain:!1,tellPage:!0});return}ee(),d(i,`starting`);let y=++p.attempt,b=()=>a||n.get(i)!==p||p.attempt!==y;o++;try{let a;try{let e=t.createPeer();p.pc=e,e.addTransceiver(`audio`,{direction:`recvonly`}),e.addTransceiver(`video`,{direction:`recvonly`}),e.createDataChannel(`dataSendChannel`),e.addEventListener(`track`,e=>{if(p.attempt!==y||!p.el||e.track?.kind!==`video`)return;let t=globalThis.MediaStream;p.el.srcObject=e.streams?.[0]??(t?new t([e.track]):null),Promise.resolve(p.el.play()).catch(()=>{}),g(i,p,e.track)}),e.addEventListener(`connectionstatechange`,()=>{p.attempt===y&&(e.connectionState===`failed`?m(i,`The video connection to the camera failed.`,{tellMain:!0,tellPage:!0}):e.connectionState===`disconnected`?p.timers.disc===void 0&&(p.timers.disc=setTimeout(()=>m(i,`The connection to the camera was lost.`,{tellMain:!0,tellPage:!0}),kr)):p.timers.disc!==void 0&&(clearTimeout(p.timers.disc),p.timers.disc=void 0))}),p.el=t.createVideoEl();let n=await e.createOffer();if(await e.setLocalDescription(n),await _(e),a=e.localDescription?.sdp??n.sdp??``,!a)throw Error(`no offer`)}catch{b()||m(i,`The video could not be set up in this window.`,{tellMain:!1,tellPage:!0});return}if(b())return;let o;try{o=await h.videoStart({page:e.pageId,frame:e.frame,connection:c,target:l,offer:a})}catch{o={ok:!1,message:`The video could not be started.`}}if(b()){o.ok&&h.videoStop?.(u(o.video))?.catch(()=>{});return}if(!o.ok){m(i,o.message,{tellMain:!1,tellPage:!0});return}p.mainId=o.video,r.set(o.video,i),p.timers.max=setTimeout(()=>m(i,`The video reached its 5-minute limit. Play again to keep watching.`,{tellMain:!0,tellPage:!0}),Tr),p.timers.nopic=setTimeout(()=>m(i,`The camera did not start playing.`,{tellMain:!0,tellPage:!0}),18e3),f();let d=s.get(o.video);s.delete(o.video);for(let e of d??[]){let t=n.get(i);t&&v(i,t,e)}}finally{--o===0&&s.clear()}},b=()=>{if(!a){if(i())for(let e of[...n.keys()])m(e,Ar,{tellMain:!0,tellPage:!0});f()}};return typeof document<`u`&&document.addEventListener(`visibilitychange`,b),{handleFrameMessage(t){let r=t.type;if(r!==`youcoded:video:start`&&r!==`youcoded:video:stop`&&r!==`youcoded:video:ack`)return!1;if(a)return!0;let o=t.id;if(typeof o!=`string`||!o||o.length>64)return!0;if(r===`youcoded:video:start`)return n.has(o)?!0:n.size>=jr?(e.post({type:er,id:o,kind:`state`,state:`stopped`,why:`A page may play at most ${jr} videos at once.`}),!0):typeof t.connection!=`string`||!t.connection||t.connection.length>64||typeof t.target!=`string`||!t.target||t.target.length>128?(e.post({type:er,id:o,kind:`state`,state:`stopped`,why:`That page asked for a video the app could not read.`}),!0):(n.set(o,{mainId:null,attempt:0,pc:null,el:null,state:`starting`,remoteSet:!1,queued:[],outstanding:0,seq:0,lastFrameAt:0,lastBitmapAt:-1/0,stopPump:null,timers:{}}),i()?(m(o,Ar,{tellMain:!1,tellPage:!0}),!0):(y(o,t.connection,t.target),!0));if(r===`youcoded:video:stop`)return m(o,null,{tellMain:!0,tellPage:!1}),!0;let s=n.get(o);return s&&typeof t.n==`number`&&t.n===s.outstanding&&(s.outstanding=0),!0},dispose(){if(!a){for(let e of[...n.keys()])m(e,`This page is not on screen any more, so its video stopped.`,{tellMain:!0,tellPage:!0});a=!0,c!==null&&(clearInterval(c),c=null),typeof document<`u`&&document.removeEventListener(`visibilitychange`,b),l?.(),l=null,n.clear(),r.clear(),s.clear()}}}}var Cr,wr,Tr,Er,Dr,Or,kr,Ar,jr,Mr=t((()=>{dr(),Cr=2e4,wr=3e3,Tr=3e5,Er=3e3,Dr=66,Or=1280,kr=1e4,Ar=`paused while the page was hidden`,jr=4}));function Nr(e,t,n,r,i){(0,Pr.useEffect)(()=>{if(!n||t===null)return;let r=fr({pageId:t,bridge:i,post:t=>{try{e.current?.contentWindow?.postMessage(t,`*`)}catch{}}}),a=Sr({pageId:t,frame:r.frame,bridge:i,deps:i()?.videoPlayback,post:(t,n)=>{let r=e.current?.contentWindow;if(!r)return!1;try{return r.postMessage(t,`*`,n),!0}catch{return!1}}}),o=t=>{if(!t.source||t.source!==e.current?.contentWindow)return;let n=t.data;n&&typeof n==`object`&&!r.handleFrameMessage(n)&&a.handleFrameMessage(n)};return window.addEventListener(`message`,o),()=>{window.removeEventListener(`message`,o),r.dispose(),a.dispose()}},[n,t,r])}var Pr,Fr=t((()=>{Pr=e(j()),br(),Mr()}));function Ir(e){return e?.connections?.find(e=>e.kind===`chats`&&e.approved)??null}function Lr(e,t){let n=Ir(t);return!!n&&n.access===e.access&&JSON.stringify(n.scope)===JSON.stringify(e.scope)}function Rr(e){return e.replace(/\\/g,`/`).replace(/\/+$/,``).split(`/`).pop()||e}function zr(e,t,n){if(`all`in e)return!0;if(`projects`in e){let n=t.projectPath;return n?e.projects.includes(Rr(n))||e.projects.includes(n):!1}return(t.tags??[]).some(e=>n.has(e))}function Br(e,t){if(!(`tag`in e))return new Set;let n=e.tag.trim().toLowerCase();return new Set(t.filter(t=>t.id===e.tag||t.label.trim().toLowerCase()===n).map(e=>e.id))}function Vr(e,t){let n=e=>typeof e==`number`&&Number.isFinite(e)&&e>0?new Date(e).toISOString():null;return{id:e.sessionId,name:e.name,lastActive:n(e.lastModified)??new Date(0).toISOString(),created:n(e.created),tags:(e.tags??[]).flatMap(e=>{let n=t.get(e);return n?[{id:n.id,name:n.label,color:n.color}]:[]}),note:e.note??``,project:e.projectPath?{name:Rr(e.projectPath),path:e.projectPath}:null,model:e.lastUsedModel?.modelId?e.lastUsedModel.modelId.replace(/-\d{8}$/,``):null,pinned:e.flags?.priority===!0,complete:e.flags?.complete===!0,branch:e.branch??null,open:e.open===!0}}function Hr(){return window.claude}async function Ur(){let e=Hr();if(typeof e?.session?.browse!=`function`)return null;try{let[t,n]=await Promise.all([e.session.browse({includeOpen:!0}),Promise.resolve(e.tags?.list?.()??[]).catch(()=>null)]);return Array.isArray(t)?{rows:t,tags:Array.isArray(n)?n:null}:null}catch{return null}}function Wr(){let e=Date.now();if(!Yr||e-Yr.at>Jr){let t={at:e,read:Ur()};Yr=t,t.read.then(e=>{e===null&&Yr===t&&(Yr=null)})}return Yr.read}function Gr(){Yr=null}function Kr(e){let t=e;if(!t||typeof t!=`object`)return null;let n=typeof t.chat==`string`&&t.chat&&t.chat.length<=200?t.chat:null;switch(t.op){case`list`:return{op:`list`};case`resume`:return n?{op:`resume`,chat:n}:null;case`setTag`:return n&&typeof t.tag==`string`&&t.tag.trim()&&t.tag.length<=200&&typeof t.on==`boolean`?{op:`setTag`,chat:n,tag:t.tag,on:t.on}:null;case`setNote`:return n&&typeof t.text==`string`?{op:`setNote`,chat:n,text:t.text}:null;case`setMark`:return n&&(t.mark===`pinned`||t.mark===`complete`)&&typeof t.on==`boolean`?{op:`setMark`,chat:n,mark:t.mark,on:t.on}:null;default:return null}}async function qr(e,t){let n=Ir(t.page());if(!n)return{ok:!1,reason:R.notAllowed};let r=Kr(e);if(!r)return{ok:!1,reason:R.badRequest};if(r.op===`resume`&&!t.clicked())return{ok:!1,reason:R.noClick};if((r.op===`setTag`||r.op===`setNote`||r.op===`setMark`)&&n.access!==`full`)return{ok:!1,reason:R.notAllowedToChange};if(r.op===`setNote`&&r.text.length>Xr)return{ok:!1,reason:R.noteTooLong};let i=await Wr();if(!i)return{ok:!1,reason:R.unavailable};if(!Lr(n,t.page()))return{ok:!1,reason:R.closed};if(i.tags===null&&(r.op===`setTag`||`tag`in n.scope))return{ok:!1,reason:R.unavailable};let a=i.tags??[],o=new Map(a.map(e=>[e.id,e])),s=Br(n.scope,a),c=i.rows.filter(e=>zr(n.scope,e,s));if(r.op===`list`)return{ok:!0,chats:c.map(e=>Vr(e,o))};let l=c.find(e=>e.sessionId===r.chat);if(!l)return{ok:!1,reason:R.outOfScope};if(r.op===`resume`)return l.missingProject||l.notSyncedYet||!l.projectSlug||!l.projectPath?{ok:!1,reason:R.cannotResume}:(window.dispatchEvent(new CustomEvent(`youcoded:resume-session`,{detail:{claudeSessionId:l.sessionId,projectSlug:l.projectSlug,projectPath:l.projectPath,provider:l.provider}})),{ok:!0});let u=Hr()?.session,d;try{if(r.op===`setTag`){let e=r.tag.trim().toLowerCase(),t=a.find(t=>t.id===r.tag||t.label.trim().toLowerCase()===e);if(!t)return{ok:!1,reason:R.unknownTag};d=await u.setTag(l.sessionId,t.id,r.on)}else d=r.op===`setNote`?await u.setNote(l.sessionId,r.text):await u.setFlag(l.sessionId,r.mark===`pinned`?`priority`:`complete`,r.on)}catch(e){return{ok:!1,reason:e instanceof Error&&e.message?e.message:`The change could not be saved.`}}finally{Gr()}return d?.ok===!1?{ok:!1,reason:typeof d.error==`string`&&d.error?d.error:`The change could not be saved.`}:{ok:!0}}var Jr,Yr,Xr,Zr=t((()=>{at(),Jr=3e3,Yr=null,Xr=8e3}));function Qr(){let[e,t]=(0,ti.useState)(()=>Date.now());return(0,ti.useEffect)(()=>{let e=setInterval(()=>{document.hidden||t(Date.now())},3e4);return()=>clearInterval(e)},[]),e}function $r(e,t){let n=Math.floor((t-new Date(e).getTime())/6e4);if(!Number.isFinite(n)||n<1)return`now`;if(n<60)return`${n}m`;let r=Math.floor(n/60);return r<24?`${r}h`:`${Math.floor(r/24)}d`}function ei({page:e,onRefresh:t}){let n=Qr(),[r,i]=(0,ti.useState)(!1),a=e.refresh;if(!a)return null;let o=async()=>{if(r)return;t?.();let n=window.claude?.pages;if(n?.refresh){i(!0);try{dt(await n.refresh(e.id))}finally{i(!1)}}},s=r?`Updating…`:a.failed?`Couldn't update`:a.at?$r(a.at,n):`Not updated yet`;return(0,Z.jsxs)(`span`,{className:`flex items-center gap-1 shrink-0 text-xs font-normal text-fg-muted`,"data-page-freshness":a.failed?`failed`:`ok`,style:{WebkitAppRegion:`no-drag`},children:[(0,Z.jsx)(`span`,{"aria-hidden":`true`,className:`text-fg-faint`,children:`·`}),(0,Z.jsx)(`span`,{children:s}),a.failed&&a.at&&!r&&(0,Z.jsxs)(`span`,{className:`max-sm:hidden text-fg-faint`,children:[`· `,$r(a.at,n)]}),(0,Z.jsx)(I,{text:a.failed?`Try again`:`Update now`,placement:`bottom`,children:(0,Z.jsx)(L,{size:`icon-sm`,variant:`ghost`,onClick:()=>{o()},"aria-label":a.failed?`Try updating ${e.name} again`:`Update ${e.name} now`,className:`w-6 h-6`,children:(0,Z.jsx)(`svg`,{className:`w-3.5 h-3.5 ${r?`animate-spin`:``}`,viewBox:`0 0 24 24`,fill:`none`,stroke:`currentColor`,strokeWidth:2,strokeLinecap:`round`,strokeLinejoin:`round`,"aria-hidden":`true`,children:(0,Z.jsx)(`path`,{d:`M20 11a8 8 0 1 0-2.3 6.3M20 4v7h-7`})})})})]})}var ti,Z,ni=t((()=>{ti=e(j()),M(),A(),Z=P()}));function ri({page:e}){let[t,n]=(0,ii.useState)(!1);if(!e.codeChanged)return null;let r=async()=>{let r=window.claude?.pages;if(r?.approve&&!t){n(!0);try{let t=await r.approve(e.id,{});t.ok&&dt(t.pages)}finally{n(!1)}}};return(0,ai.jsxs)(`span`,{className:`flex items-center gap-1 shrink-0 text-xs font-normal text-fg-muted`,"data-page-code-changed":!0,style:{WebkitAppRegion:`no-drag`},children:[(0,ai.jsx)(`span`,{"aria-hidden":`true`,className:`text-fg-faint`,children:`·`}),(0,ai.jsx)(I,{text:`Its connections are the same, so it still reaches only what you allowed.`,placement:`bottom`,children:(0,ai.jsx)(`span`,{className:`max-sm:hidden`,children:`Code changed since you allowed this`})}),(0,ai.jsx)(`span`,{className:`sm:hidden`,children:`Code changed`}),(0,ai.jsx)(Ve,{onClick:()=>{r()},label:`Dismiss the code-changed note`,className:`w-6 h-6`})]})}var ii,ai,oi=t((()=>{ii=e(j()),M(),A(),ai=P()}));function si(e){let[t,n]=(0,ci.useState)(()=>On());return(0,ci.useEffect)(()=>{if(!e)return;let t=()=>n(On());t();let r=new MutationObserver(t);return r.observe(document.documentElement,{attributes:!0,attributeFilter:[`data-wallpaper`,re]}),r.observe(document.body,{attributes:!0,attributeFilter:[`data-chrome-style`]}),()=>r.disconnect()},[e]),t}var ci,li=t((()=>{ci=e(j()),dr(),Te()}));function ui(){return window.claude?.pages}function di(e){let t=e;return!!t&&typeof t==`object`&&Array.isArray(t.send)&&t.send.every(e=>typeof e==`string`)&&typeof t.until==`number`&&(t.timeoutMs===void 0||typeof t.timeoutMs==`number`)}function fi(e){return!!e&&typeof e==`object`&&!Array.isArray(e)&&Object.values(e).every(e=>typeof e==`string`)}async function pi(e,t){if(e.kind===`project`)return e.path;if(typeof t!=`string`||!t.trim())return;let n=e=>e.replace(/\\/g,`/`).replace(/\/+$/,``).toLowerCase();try{let e=await window.claude?.folders?.list?.();if(!Array.isArray(e))return;let r=n(t.trim());return e.find(e=>typeof e?.path==`string`&&n(e.path)===r)?.path}catch{return}}function mi({settingsOpen:e,onToggleSettings:t,settingsBadge:n,settingsDangerBadge:r,onCreatePage:i,projectRoot:a=null,onStartSession:o}){let c=Ke(),u=ie(e=>e.pageViewOpen),d=ie(e=>e.openPageId),p=ie(e=>e.pagesViewOpen),m=ie(e=>e.pageFocus),h=C(),g=de(h),[_,v]=(0,Q.useState)(!0),y=d;(0,Q.useEffect)(()=>{v(y===null)},[y]);let b=e=>{c({type:`PAGE_OPENED`,pageId:e}),v(!1)},te=()=>c({type:`PAGE_VIEW_CLOSED`}),x=()=>c({type:`PAGES_VIEW_OPENED`});nt(u&&!p&&!e,te);let re=l(),{pages:w,loaded:T,failed:E,pinnedTotal:ae}=S();(0,Q.useEffect)(()=>{if(!We())return;let e=new URLSearchParams(location.search).get(`openPage`);e&&c({type:`PAGE_OPENED`,pageId:e,focus:h})},[c,h]);let oe=w.map(e=>e.id);z(`pages/page`,e=>{e&&c({type:`PAGE_OPENED`,pageId:e})},oe),z(`pages/focus`,e=>{e&&c({type:`PAGE_OPENED`,pageId:e,focus:!0})},oe),z(`office/home`,()=>c({type:`PAGE_OPENED`,pageId:B})),z(`office/first-run`,()=>c({type:`PAGE_OPENED`,pageId:B})),z(`office/rename`,()=>c({type:`PAGE_OPENED`,pageId:B})),z(`office/document`,()=>{ot(0),c({type:`PAGE_OPENED`,pageId:B,focus:!0})}),z(`office/spreadsheet`,()=>{ot(1),c({type:`PAGE_OPENED`,pageId:B,focus:!0})}),z(`office/presentation`,()=>{ot(2),c({type:`PAGE_OPENED`,pageId:B,focus:!0})}),z(`office/document-comments`,()=>{je(`document`),c({type:`PAGE_OPENED`,pageId:B,focus:!0})}),z(`office/spreadsheet-comments`,()=>{je(`spreadsheet`),c({type:`PAGE_OPENED`,pageId:B,focus:!0})}),z(`office/versions`,()=>{ot(0,!0),c({type:`PAGE_OPENED`,pageId:B,focus:!0})});let D=w.find(e=>e.id===d)??null,O=d===B,se=ne().docs.length>0,ce=w.filter(e=>e.home.kind!==`builtin`),le=ae??w.filter(e=>e.pinned).length,ue=D?.htmlStamp??0,fe=(0,Q.useMemo)(()=>(D?.connections??[]).map(e=>`${e.id}:${+!!e.approved}${e.kind===`device`?`@${e.address}`:``}`).join(`|`),[D]),pe=u&&d!==null&&T&&!E&&!D;(0,Q.useEffect)(()=>{pe&&c({type:`PAGE_CLOSED`})},[pe,c]);let[k,me]=(0,Q.useState)({state:`loading`}),[A,j]=(0,Q.useState)(!1),he=d===null&&k.state===`idle`&&T&&!E&&ce.length===0,ge=u&&!m&&(!he||w.some(e=>e.home.kind===`builtin`)),M=g&&ge&&!he&&(d===null||_),ve=M||!ge?`translateX(0)`:`translateX(calc(-100% - var(--frame-edge, 10px)))`,N=(0,Q.useRef)(null),P=(0,Q.useRef)(`null`),ye=(0,Q.useRef)(!1),be=(0,Q.useRef)(null);be.current=k.state===`ready`?k.page:null;let F=(0,Q.useRef)(o);F.current=o;let xe=si(u);(0,Q.useEffect)(()=>{if(!u)return;if(s(),d===null||d===`builtin:office`){me({state:`idle`});return}let e=!1;me({state:`loading`});let t=ui();if(!t)me({state:`failed`,failure:{kind:`unreadable`,message:`Pages are not available in this window.`}});else return t.get(d).then(t=>{if(!e){if(t.ok){try{P.current=JSON.stringify(t.page.data??null)}catch{P.current=`null`}let e=On();me({state:`ready`,page:t.page,doc:Fn(t.page.html,kn(document.documentElement,e),wn,t.page.data,t.page.connections??[],e)})}else me({state:`failed`,failure:t.failure})}},()=>{e||me({state:`failed`,failure:{kind:`unreadable`,message:`The page could not be read.`}})}),()=>{e=!0}},[u,d,ue,fe]),(0,Q.useEffect)(()=>{if(k.state!==`ready`||d===null)return;let e=null,t,n=()=>{if(e=null,t===void 0)return;let n=t;t=void 0;let r=ui()?.setData(d,n);r?r.then(()=>{e===null&&t===void 0&&(ye.current=!1)},()=>{e===null&&t===void 0&&(ye.current=!1)}):ye.current=!1},r=r=>{if(r.source!==N.current?.contentWindow)return;let i=r.data;if(!i)return;if(i.type===`youcoded:edges`){let e=N.current;e&&(e.dataset.fadeTop=String(i.top===!0),e.dataset.fadeBottom=String(i.bottom===!0));return}if(i.type===`youcoded:esc`){re();return}if(i.type===`youcoded:session:start`){if(typeof i.id!=`string`)return;let e=i.id,t=r.source,n=(n,r)=>{try{t.postMessage({type:nr,id:e,result:n?{ok:n}:{ok:n,reason:r}},`*`)}catch{}},a=e=>!!e?.connections?.some(e=>e.kind===`session`&&e.approved),o=be.current,s=F.current,c=i.prompt;if(!o||!s||!a(o)){n(!1,ct.notAllowed);return}if(!navigator.userActivation?.isActive||document.activeElement!==N.current){n(!1,ct.noClick);return}if(typeof c!=`string`||!c.trim()||c.length>2e4){n(!1,ct.badMessage);return}if(tt.test(c)){n(!1,ct.hidden);return}pi(o.home,i.project).then(e=>{let t=be.current;if(t?.id!==o.id||!a(t)){n(!1,ct.closed);return}let r=F.current?.({prompt:c,cwd:e,pageName:o.name})===!0;n(r,r?void 0:ct.alreadyOpen)});return}if(i.type===`youcoded:chats`){if(typeof i.id!=`string`)return;let e=i.id,t=r.source,n=n=>{try{t.postMessage({type:ir,id:e,result:n},`*`)}catch{}};qr(i.request,{page:()=>be.current,clicked:()=>!!navigator.userActivation?.isActive&&document.activeElement===N.current}).then(n,()=>n({ok:!1,reason:R.unavailable}));return}if(i.type===`youcoded:program`){if(typeof i.id!=`string`)return;let e=i.id,t=r.source,n=n=>{try{t.postMessage({type:or,id:e,result:n},`*`)}catch{}},a=i.file,o=i.input,s=e=>!!e?.connections?.some(e=>e.kind===`program`&&e.approved&&e.file===a),c=be.current;if(typeof a!=`string`||!c||!s(c)){n({ok:!1,reason:Oe.notAllowed});return}if(typeof o!=`string`||o.length>1e6){n({ok:!1,reason:Oe.badRequest});return}let l=ui();if(!l?.runProgram){n({ok:!1,reason:Oe.unsupported});return}l.runProgram(d,a,o).then(e=>{n(be.current?.id===c.id&&s(be.current)?e:{ok:!1,reason:Oe.closed})},()=>n({ok:!1,reason:`The program could not be run.`}));return}if(i.type===`youcoded:plaid`){if(typeof i.id!=`string`)return;let e=i.id,t=r.source,n=n=>{try{t.postMessage({type:Kn,id:e,result:n},`*`)}catch{}},a=ui(),o=i.request?.op??`status`;if(!a?.plaid){n({ok:!1,op:o,code:`UNSUPPORTED`,message:`Bank connections work in YouCoded on your computer only.`});return}a.plaid(d,i.request).then(n,()=>{n({ok:!1,op:o,code:`UNKNOWN`,message:`The bank request could not be completed.`})});return}if(i.type===`youcoded:fetch`){if(typeof i.id!=`string`)return;let e=i.id,t=r.source,n=n=>{try{t.postMessage({type:Wn,id:e,result:n},`*`)}catch{}},a=ui();if(!a?.fetch){n({ok:!1,reason:`unsupported`,message:`This window cannot make requests for pages.`});return}let o={url:typeof i.url==`string`?i.url:``,...typeof i.method==`string`?{method:i.method}:{},...fi(i.headers)?{headers:i.headers}:{},...typeof i.body==`string`?{body:i.body}:{},...i.as===`picture`?{as:`picture`}:i.as===`video`?{as:`video`}:{},...di(i.socket)?{socket:i.socket}:{}};a.fetch(d,o).then(n,()=>{n({ok:!1,reason:`network`,message:`The request could not be completed.`})});return}if(i.type!==`youcoded:data:set`)return;let a=``;try{a=JSON.stringify(i.data??null)}catch{return}a.length>1e6||(P.current=a,ye.current=!0,t=i.data??null,e===null&&(e=setTimeout(n,500)))};return window.addEventListener(`message`,r),()=>{window.removeEventListener(`message`,r),e!==null&&(clearTimeout(e),n())}},[k.state,d,re]),(0,Q.useEffect)(()=>{if(k.state!==`ready`||d===null||ye.current)return;let e=ui();if(!e)return;let t=!1;return e.get(d).then(e=>{if(t||!e.ok||ye.current)return;let n=``;try{n=JSON.stringify(e.page.data??null)}catch{return}n!==P.current&&(P.current=n,N.current?.contentWindow?.postMessage({type:Vn,data:e.page.data??null},`*`))},()=>{}),()=>{t=!0}},[w,k.state,d]),(0,Q.useEffect)(()=>{if(k.state===`ready`)return In((e,t)=>{N.current?.contentWindow?.postMessage({type:Rn,css:e,seeThrough:t},`*`)})},[k.state]);let Se=(0,Q.useMemo)(()=>D?.name??(k.state===`ready`?k.page.name:``),[D,k]),Ce=k.state===`ready`?k.page:null,we=Et(Ce??D),Te=u&&k.state===`ready`&&!we&&!!Ce?.connections?.some(e=>e.kind===`program`&&e.approved),Ee=k.state===`ready`?k.doc:null;(0,Q.useEffect)(()=>{if(!Te||d===null)return;let e=d;return()=>{ui()?.stopPrograms?.(e)?.catch?.(()=>{})}},[Te,d,Ee]),Nr(N,d,u&&k.state===`ready`&&!we,k.state===`ready`?k.doc:null,ui);let De=()=>{N.current?.contentWindow?.postMessage({type:Hn},`*`)},ke=e=>{(Fe(e)||!Be(e))&&(Le(Fe(e)?e:ee),c({type:`PAGE_OPENED`,pageId:B,focus:!0}))};if(!u&&!se)return(0,$.jsx)(vn,{onReview:ke});let Me=w.filter(e=>e.home.kind===`builtin`),Ne=w.filter(e=>e.home.kind===`personal`),Pe=new Map;for(let e of w){if(e.home.kind!==`project`)continue;let t=Pe.get(e.home.name)??[];t.push(e),Pe.set(e.home.name,t)}return(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(vn,{onReview:ke}),(0,$.jsxs)(`div`,{className:`screen-view fixed inset-0 bg-panel z-40 flex flex-col ${u?``:`invisible pointer-events-none`}`,"aria-hidden":!u||void 0,inert:!u,"data-screen-frame":Ae(),children:[u&&(0,$.jsx)(pt,{settingsOpen:e,onToggleSettings:t,settingsBadge:n,settingsDangerBadge:r,active:m?null:`pages`,onBack:te,extra:g&&ge&&d!==null?(0,$.jsx)(`div`,{className:`bg-inset rounded-md p-0.5`,children:(0,$.jsx)(I,{text:M?`Show the page`:`Show the page list`,placement:`bottom`,children:(0,$.jsx)(`button`,{type:`button`,"aria-label":M?`Show the page`:`Show the page list`,"aria-pressed":M,onClick:()=>v(!M),className:`px-2 py-1 rounded-[var(--radius-toggle)] transition-colors flex items-center ${M?`bg-accent text-on-accent`:Ye}`,children:(0,$.jsx)(_i,{collapsed:!M})})})}):void 0,icon:D?(0,$.jsx)(rt,{icon:D.icon,customIcon:D.customIcon,className:`w-4 h-4`}):(0,$.jsx)(_e,{className:`w-4 h-4`}),title:(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(`span`,{className:`truncate`,children:Se||`Pages`}),D&&!we&&(0,$.jsx)(ei,{page:D,onRefresh:De}),D&&!we&&(0,$.jsx)(ri,{page:D})]})}),(0,$.jsxs)(`div`,{className:`screen-body flex-1 min-h-0 flex${g?` relative overflow-hidden`:``}`,style:g?{paddingTop:1}:void 0,children:[u&&!m&&(!he||Me.length>0)&&(0,$.jsxs)(`aside`,{inert:g&&!M,"aria-hidden":g&&!M?!0:void 0,className:`screen-pane screen-pane--panel ${g?`w-full shrink-0 transition-transform duration-300 motion-reduce:transition-none`:A?`w-12 shrink-0`:`w-60 shrink-0`} ${g?``:`relative`} flex flex-col select-none rounded-xl bg-canvas overflow-hidden${xe?` panel-glass`:``}`,style:g?{transform:ve}:void 0,children:[M&&k.state===`idle`&&T&&!E&&(0,$.jsx)(ze,{name:`pages`}),!g&&(0,$.jsx)(`div`,{className:!g&&A?`flex items-center justify-center px-2 pt-2`:`absolute top-3 right-3 z-10`,children:(0,$.jsx)(I,{text:A?`Show the page list`:`Hide the page list`,placement:`bottom`,children:(0,$.jsx)(L,{size:`icon-sm`,variant:`ghost`,"aria-label":A?`Show the page list`:`Hide the page list`,"aria-expanded":!A,onClick:()=>j(e=>!e),className:`w-7 h-7`,children:(0,$.jsx)(_i,{collapsed:A})})})}),!g&&A?(0,$.jsx)(`div`,{className:`scroll-mask flex-1 overflow-y-auto flex flex-col items-center gap-1 py-1`,children:[...Me,...Ne,...[...Pe.values()].flat()].map(e=>(0,$.jsx)(I,{text:e.name,placement:`bottom`,children:(0,$.jsx)(L,{size:`icon-sm`,variant:`ghost`,"aria-label":`Open ${e.name}`,"aria-current":e.id===d?`page`:void 0,onClick:()=>b(e.id),className:`w-8 h-8 ${e.id===d?`bg-inset`:``}`,children:(0,$.jsx)(rt,{icon:e.icon,customIcon:e.customIcon,className:`w-4 h-4`})})},e.id))}):(0,$.jsxs)($.Fragment,{children:[(0,$.jsxs)(`div`,{className:`scroll-mask flex-1 overflow-y-auto p-2`,children:[Me.length>0&&(0,$.jsx)(hi,{label:`Built in`,children:Me.map(e=>(0,$.jsx)(gi,{page:e,current:e.id===d,pinFull:le>=4,onOpen:()=>b(e.id)},e.id))}),Ne.length>0&&(0,$.jsx)(hi,{label:`Personal`,children:Ne.map(e=>(0,$.jsx)(gi,{page:e,current:e.id===d,pinFull:le>=4,onOpen:()=>b(e.id)},e.id))}),[...Pe.entries()].map(([e,t])=>(0,$.jsx)(hi,{label:e,children:t.map(e=>(0,$.jsx)(gi,{page:e,current:e.id===d,pinFull:le>=4,onOpen:()=>b(e.id)},e.id))},e))]}),(0,$.jsxs)(`div`,{className:`p-3 flex flex-col gap-2`,children:[ce.length>0&&(0,$.jsxs)(L,{variant:`primary`,onClick:i,className:`w-full justify-center rounded-full`,children:[(0,$.jsx)(vi,{}),`Create a page`]}),(0,$.jsxs)(L,{variant:`secondary`,onClick:x,className:`w-full justify-center rounded-full`,children:[(0,$.jsx)(_e,{className:`w-3.5 h-3.5`}),`Manage pages`]})]})]})]}),(0,$.jsxs)(`div`,{inert:g&&M,className:`screen-pane screen-pane--frame ${g?`w-full shrink-0 transition-transform duration-300 motion-reduce:transition-none`:`relative flex-1 min-w-0`} rounded-xl overflow-hidden bg-canvas${xe?` panel-glass`:``}`,style:g?{transform:ve}:void 0,children:[(O||se)&&(0,$.jsx)(`div`,{className:`absolute inset-0 ${u&&O?``:`invisible pointer-events-none`}`,"aria-hidden":u&&O?void 0:!0,inert:!(u&&O),children:(0,$.jsx)(Gt,{projectRoot:a,visible:u&&O})}),u&&(0,$.jsxs)($.Fragment,{children:[k.state===`idle`&&T&&!E&&!O&&!M&&(0,$.jsx)(ze,{name:`pages`}),k.state===`ready`&&d&&(0,$.jsx)(ze,{name:`pages/${m?`focus`:`page`}/${d}`}),k.state===`idle`&&!T&&(0,$.jsx)(f,{what:`pages`}),k.state===`idle`&&T&&E&&(0,$.jsx)(V,{message:`The list of pages could not be read.`,onRetry:()=>void s()}),he&&(0,$.jsx)(`div`,{className:`scroll-mask absolute inset-0 overflow-y-auto flex flex-col`,children:(0,$.jsx)(Sn,{onMake:i})}),k.state===`idle`&&T&&!E&&!O&&ce.length>0&&(0,$.jsxs)(`div`,{className:`absolute inset-0 flex flex-col items-center justify-center gap-1 select-none`,children:[(0,$.jsx)(`div`,{className:`text-sm font-medium text-fg-2`,children:`No page selected`}),(0,$.jsx)(`div`,{className:`text-xs text-fg-muted`,children:`Pick one from the list, or create a page.`})]}),k.state===`loading`&&(0,$.jsx)(f,{what:Se,verb:`Opening`}),k.state===`failed`&&(0,$.jsx)(`div`,{className:`p-6 max-w-xl mx-auto`,children:(0,$.jsx)(V,{message:k.failure.message,onRetry:()=>{d!==null&&c({type:`PAGE_OPENED`,pageId:d})}})}),k.state===`ready`&&we&&(0,$.jsx)(Ot,{page:k.page,onNotNow:()=>c({type:m?`PAGE_VIEW_CLOSED`:`PAGE_CLOSED`})}),k.state===`ready`&&!we&&(0,$.jsx)(`iframe`,{ref:N,srcDoc:k.doc,sandbox:`allow-scripts allow-popups allow-forms`,className:`scroll-mask-frame absolute inset-0 w-full h-full border-0 ${xe?``:`bg-canvas`}`,title:Se})]})]})]})]})]})}function hi({label:e,children:t}){return(0,$.jsxs)(`div`,{className:`pb-2`,children:[(0,$.jsx)(`div`,{className:`px-2 pt-2 pb-1`,children:(0,$.jsx)(De,{children:e})}),t]})}function gi({page:e,current:t,pinFull:n,onOpen:r}){let i=!e.pinned&&n;return(0,$.jsxs)(`div`,{role:`button`,tabIndex:0,"data-rail-page":e.id,"aria-current":t?`page`:void 0,onClick:r,onKeyDown:e=>{e.target===e.currentTarget&&(e.key===`Enter`||e.key===` `)&&(e.preventDefault(),r())},className:`group flex items-center gap-2.5 h-8 pl-2 pr-1 rounded-md text-sm text-left cursor-pointer transition-colors ${t?`bg-inset text-fg`:`text-fg-2 hover:text-fg hover:bg-inset/60`}`,children:[(0,$.jsx)(rt,{icon:e.icon,customIcon:e.customIcon,className:`w-4 h-4 shrink-0`}),(0,$.jsx)(`span`,{className:`flex-1 min-w-0 truncate`,children:e.name}),(0,$.jsx)(I,{text:i?`Up to 4 pinned pages`:e.pinned?`Unpin from the top bar`:`Pin to the top bar`,placement:`bottom`,children:(0,$.jsx)(L,{size:`icon-sm`,variant:`ghost`,"aria-label":e.pinned?`Unpin ${e.name}`:`Pin ${e.name}`,"aria-pressed":e.pinned,disabled:i,onClick:t=>{t.stopPropagation(),be(e.id,!e.pinned)},className:`w-6 h-6`,children:(0,$.jsx)(`span`,{className:e.pinned?`text-fg`:`text-fg-faint group-hover:text-fg-muted`,children:(0,$.jsx)(p,{filled:e.pinned})})})})]})}function _i({collapsed:e}){return(0,$.jsxs)(`svg`,{className:`w-4 h-4`,viewBox:`0 0 24 24`,fill:`none`,stroke:`currentColor`,strokeWidth:1.8,strokeLinecap:`round`,strokeLinejoin:`round`,"aria-hidden":`true`,children:[(0,$.jsx)(`rect`,{x:`3`,y:`4`,width:`18`,height:`16`,rx:`2.5`}),(0,$.jsx)(`path`,{d:`M9 4v16`}),(0,$.jsx)(`path`,{d:e?`M13.5 10l2 2-2 2`:`M16 10l-2 2 2 2`})]})}function vi(){return(0,$.jsx)(`svg`,{className:`w-3.5 h-3.5`,viewBox:`0 0 24 24`,fill:`none`,stroke:`currentColor`,"aria-hidden":`true`,children:(0,$.jsx)(`path`,{strokeLinecap:`round`,strokeWidth:2.5,d:`M12 5v14M5 12h14`})})}var Q,$;t((()=>{Q=e(j()),oe(),he(),g(),O(),Qe(),M(),Me(),ft(),at(),sn(),Ze(),xn(),d(),Cn(),A(),Fr(),Dn(),Dt(),Zr(),ni(),oi(),li(),dr(),a(),$=P()}))();export{mi as PageHost};