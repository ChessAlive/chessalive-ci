// Self-contained release console: no external fonts, scripts, or asset requests.
const styles = String.raw`
:root{color-scheme:light;--paper:#f5f5f0;--surface:#fff;--ink:#172a35;--muted:#677780;--line:#e3e8e5;--green:#007e66;--green-soft:#e8f5ee;--orange:#9a5a0c;--red:#b13243;--mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper);font-synthesis:none}*{box-sizing:border-box}body{margin:0}button,input,a{-webkit-tap-highlight-color:transparent}button,input{font:inherit}button,a{touch-action:manipulation}button{cursor:pointer}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}button:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid #09a68a;outline-offset:4px}button{color:inherit}.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}.muted{color:var(--muted)}.eyebrow{font-size:10px;font-weight:750;letter-spacing:1.7px;text-transform:uppercase}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.topbar{height:80px;background:#fff;border-bottom:1px solid var(--line)}.topbar-inner{max-width:1504px;margin:auto;padding:0 40px;height:100%;display:flex;align-items:center;gap:38px}.brand{display:flex;align-items:center;gap:11px;white-space:nowrap;font-size:20px;letter-spacing:-.65px;font-weight:750}.brand-mark{width:35px;height:35px;border-radius:9px;background:transparent;object-fit:contain}.brand-sub{font-size:10px;font-weight:600;letter-spacing:1.4px;margin-left:12px;padding-left:20px;border-left:1px solid var(--line);color:var(--muted)}.nav-current{font-size:13px;font-weight:650;align-self:stretch;display:flex;align-items:center;border-bottom:2px solid var(--green);padding:0 4px}.top-right{margin-left:auto;display:flex;align-items:center;gap:24px}.link{font-size:12px;font-weight:650}.link span{margin-left:6px;color:var(--muted)}.avatar{height:31px;width:31px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:700;border:1px solid #d5e2dc;background:#edf3ef;color:#486657}.shell{max-width:1424px;margin:auto;padding:30px 40px 25px}.page-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px}.breadcrumb{font-size:11px;color:var(--muted);margin:0 0 13px;display:flex;gap:9px}.breadcrumb span{color:#a6b2af}h1{font-size:26px;line-height:1.2;letter-spacing:-.85px;margin:0;font-weight:680}.page-subtitle{font-size:12px;color:var(--muted);margin:9px 0 0;line-height:1.6}.connection{font-size:11px;display:flex;gap:7px;align-items:center;color:var(--muted);white-space:nowrap}.dot{width:6px;height:6px;border-radius:50%;background:#89979d;display:inline-block;flex:none}.connection.connected .dot{background:var(--green);box-shadow:0 0 0 3px #007e6610}.connection.disconnected{color:var(--orange)}.connection.disconnected .dot{background:#d79032}.hero{isolation:isolate;position:relative;overflow:hidden;border-radius:16px;background:#152c37;color:#fff;padding:29px 33px;display:flex;align-items:center;justify-content:space-between;gap:28px;min-height:194px}.hero:after{content:"";position:absolute;z-index:-1;right:130px;top:-70px;width:370px;height:350px;opacity:.12;transform:rotate(-27deg);background:repeating-linear-gradient(0deg,transparent 0,transparent 46px,#94b1b8 47px,#94b1b8 48px),repeating-linear-gradient(90deg,transparent 0,transparent 46px,#94b1b8 47px,#94b1b8 48px);mask-image:linear-gradient(90deg,transparent,#000)}.hero-kicker{display:flex;align-items:center;gap:10px;color:#93b5b4;margin:0 0 22px;font-size:10px;letter-spacing:1.6px;font-weight:650}.hero-kicker .dot{background:#71d2af;box-shadow:0 0 0 4px #71d2af12}.route{display:flex;align-items:center;gap:25px}.route-city{font-size:32px;letter-spacing:-1px;font-weight:580;line-height:1.15}.route-label{display:block;font-size:10px;color:#9db0b8;letter-spacing:.1px;margin-top:9px}.route-arrow{width:68px;height:1px;background:#55736f;position:relative;margin-top:-14px}.route-arrow:after{content:"";position:absolute;width:6px;height:6px;border-top:1px solid #87b8a9;border-right:1px solid #87b8a9;right:0;top:-3px;transform:rotate(45deg)}.route-arrow:before{content:"";position:absolute;top:-3px;left:0;width:6px;height:6px;border-radius:50%;background:#68c6a9}.hero-copy{font-size:11px;color:#a9bfc4;line-height:1.7;margin:21px 0 0}.hero-action{text-align:right;flex:none}.primary{background:#c8f1db;color:#143d30;padding:14px 19px;border:1px solid #daf9e7;border-radius:8px;font-size:12px;font-weight:750;box-shadow:0 3px 8px #03180b18;display:inline-flex;align-items:center;justify-content:center;gap:24px;min-height:45px;transition:background .15s,transform .15s}.primary:hover:not(:disabled){background:#e3ffed;transform:translateY(-1px)}.primary .arrow{font-size:18px;font-weight:400}.hero-action-note{font-size:10px;color:#8fa9b0;margin:11px 0 0}.run-label{font-size:10px;color:#a3c4bc;margin:0 0 10px}.notice{padding:13px 16px;font-size:12px;border-radius:9px;line-height:1.6;background:#fff7e9;border:1px solid #f0d9b4;color:#795315;margin:16px 0 0}.notice[hidden]{display:none}.notice a{text-decoration:underline;font-weight:700}.metrics{display:grid;grid-template-columns:1fr 1fr 1.17fr;margin:19px 0 24px;background:#fff;border:1px solid var(--line);border-radius:13px;overflow:hidden}.metric{padding:23px 25px;min-width:0}.metric+.metric{border-left:1px solid var(--line)}.metric-label{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--muted);font-weight:700;letter-spacing:1.15px;text-transform:uppercase}.metric-icon{font-size:16px;color:#7f9594;font-weight:400;line-height:1}.metric-value{font-size:35px;line-height:1.25;letter-spacing:-1.4px;margin:12px 0 7px;font-weight:550;white-space:nowrap}.metric-note{font-size:10px;color:var(--muted);line-height:1.65;margin:0}.metric-active{font-size:19px;letter-spacing:-.5px;line-height:1.5;margin-top:12px;margin-bottom:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.content-grid{display:grid;grid-template-columns:minmax(0,1fr) 326px;gap:22px;align-items:start}.main-column,.sidebar{display:grid;gap:20px;min-width:0}.card{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;min-width:0}.card-header{padding:22px 23px 18px;display:flex;align-items:center;justify-content:space-between;gap:14px}.card-title{margin:0;font-size:14px;font-weight:680;letter-spacing:-.3px}.card-subtitle{font-size:10px;color:var(--muted);margin:6px 0 0;line-height:1.5}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:5px;padding:5px 8px;background:#f2f4f3;color:#6c7b7f;font-size:10px;line-height:1.35;font-weight:600;white-space:nowrap;border:1px solid #e8edeb}.badge.green{background:#e9f6ef;color:#157353;border-color:#deefe5}.badge.green .dot{background:#21916b}.badge.orange{background:#fff5e4;color:#925b16;border-color:#f1e5cc}.badge.orange .dot{background:#c08830}.badge.red{background:#fff0f1;color:#b03b4b;border-color:#f4dfe3}.badge.red .dot{background:#be4055}.pipeline-summary{padding:0 23px 20px;display:flex;align-items:center;gap:13px;border-bottom:1px solid var(--line)}.pipeline-track{height:4px;background:#edf1ed;border-radius:10px;flex:1;overflow:hidden}.pipeline-track span{display:block;height:100%;background:var(--green);transition:width .3s;border-radius:10px}.pipeline-count{font-size:10px;color:var(--muted);white-space:nowrap}.pipeline-columns{display:grid;grid-template-columns:minmax(0,1fr) 70px 80px;gap:15px;padding:13px 23px 10px 64px;background:#fafbf8;color:#8b979b;font-size:9px;font-weight:650;letter-spacing:.8px;text-transform:uppercase;border-bottom:1px solid #edf0eb}.pipeline-columns span:not(:first-child){text-align:right}.timeline{margin:0;padding:0;list-style:none}.step{display:grid;grid-template-columns:25px minmax(0,1fr) 70px 80px;gap:15px;padding:15px 23px;position:relative;align-items:center}.step+.step{border-top:1px solid #f0f2ee}.step.running{background:#f0f8f3}.step-icon{display:grid;place-items:center;height:24px;width:24px;border:1px solid #e3e8e5;border-radius:50%;font:10px var(--mono);color:#9aa5a8;background:#fff;position:relative;z-index:1}.step.done .step-icon{color:#157958;background:#edf8f1;border-color:#d6eee1;font-family:inherit;font-size:13px}.step.running .step-icon{background:#007e66;color:white;border-color:#007e66}.step.failed .step-icon{background:#fff0f0;border-color:#f5d8dc;color:#b63143;font-family:inherit;font-weight:700}.step.skipped .step-icon{background:#f5f6f4;color:#9aa5a8}.step-name{display:block;font-size:11px;font-weight:650;line-height:1.4}.step-detail{font-size:10px;color:#839093;margin-top:4px;line-height:1.4;display:block}.step.running .step-name{color:#075e48}.step-time,.step-memory{text-align:right;font:11px var(--mono);font-variant-numeric:tabular-nums;color:#576c71;white-space:nowrap}.step-memory{font-size:10px;color:#8a9699}.step.running .step-time{color:#007956;font-weight:650}.step-time-wrap{display:grid;gap:7px}.step-track{height:2px;background:#e7ede8;border-radius:2px;overflow:hidden;width:58px;margin-left:auto}.step-track span{height:100%;display:block;background:#b9cdc0}.step.running .step-track span{background:var(--green)}.step.failed .step-track span{background:#c7757e}.pipeline-foot{padding:12px 23px;border-top:1px solid var(--line);font-size:9px;color:#829094;line-height:1.6;background:#fcfcfa}.spinner{width:11px;height:11px;border:1.5px solid #ffffff66;border-top-color:currentColor;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.memory-card .card-header{padding-bottom:12px}.memory-values{display:flex;align-items:baseline;gap:9px;padding:0 23px;margin-bottom:5px}.memory-current{font-size:21px;letter-spacing:-.5px;font-weight:500}.memory-unit-note{font-size:10px;color:#8a9899}.chart-box{margin:9px 23px 0;height:100px;position:relative;border-bottom:1px solid #e1e9e3;background:repeating-linear-gradient(to top,transparent 0,transparent 32px,#f0f3ee 32px,#f0f3ee 33px)}.chart-box svg{height:100%;width:100%;overflow:visible;display:block}.chart-empty{height:100%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#9aa6a6;text-align:center}.chart-scale{margin:8px 23px 17px;display:flex;justify-content:space-between;color:#899899;font:9px var(--mono)}.memory-foot{padding:12px 23px;background:#fcfcfa;border-top:1px solid #eff1ec;font-size:9px;line-height:1.6;color:#859294}.side-body{padding:0 23px 22px}.production-link{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:650;padding:1px 0 17px;border-bottom:1px solid var(--line);color:#1d5148;gap:12px;word-break:break-word}.production-link span{font-size:15px}.metadata{margin:0}.metadata-row{display:flex;justify-content:space-between;gap:14px;padding-top:15px;font-size:10px;line-height:1.5}.metadata dt{color:#849095;flex:none}.metadata dd{margin:0;text-align:right;min-width:0;overflow-wrap:anywhere;color:#536971}.metadata dd a{color:#11775d}.commit-message{font-size:10px;line-height:1.65;color:#6f8084;margin:16px 0 0;padding:11px 12px;border-radius:6px;background:#f5f7f2;overflow-wrap:anywhere}.monitor-description{font-size:11px;line-height:1.6;color:#75858a;margin:0 0 15px}.checks{display:grid;gap:0}.check{display:flex;justify-content:space-between;align-items:center;padding:10px 0;gap:10px;border-top:1px solid #eef1eb;font-size:10px}.check-name{color:#53666f;font-family:var(--mono);display:flex;align-items:center;gap:8px;min-width:0;overflow-wrap:anywhere}.check-dot{background:#b1bcb8;width:5px;height:5px;flex:none;border-radius:50%}.check.ok .check-dot{background:#39a17a}.check.bad .check-dot{background:#c65260}.check-result{font:9px var(--mono);color:#8b999e;white-space:nowrap}.check.bad .check-result{color:#b54d5a}.monitor-foot{font-size:9px;color:#909c9e;line-height:1.6;padding-top:13px;border-top:1px solid var(--line)}.notification-copy{font-size:10px;color:#7b8b8f;line-height:1.7;margin:0 0 14px}.admins{list-style:none;padding:0;margin:0;display:grid;gap:10px}.admins li{font-size:10px;color:#526972;display:flex;gap:8px;align-items:center;overflow-wrap:anywhere;word-break:break-word}.admin-dot{width:18px;height:18px;flex:none;border-radius:50%;background:#f0f4ec;color:#7e9486;display:grid;place-items:center;font-size:9px}.mail-note{font-size:9px;line-height:1.6;color:#8a9799;padding-top:15px;margin:15px 0 0;border-top:1px solid var(--line)}.logs-card{background:#152832;border-color:#152832;color:#e4ebea}.logs-card .card-header{padding:18px 21px;border-bottom:1px solid #29404a}.logs-card .card-title{font-size:12px;font-weight:550;display:flex;gap:10px;align-items:center}.terminal-icon{color:#96b4ac;font:12px var(--mono)}.log-actions{display:flex;align-items:center;gap:14px}.autoscroll{font-size:10px;color:#94a8ad;display:flex;align-items:center;gap:6px;cursor:pointer}.autoscroll input{accent-color:#72c6a5;margin:0;height:12px;width:12px}.small-button{padding:5px 8px;border:1px solid #3b5059;border-radius:5px;color:#afc1c5;background:transparent;font-size:10px}.small-button:hover{background:#29404b}.log{margin:0;min-height:185px;max-height:400px;overflow:auto;padding:20px 22px 25px;color:#a9c6bf;font:10px/1.9 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-color:#3a5560 transparent}.logs-foot{padding:10px 22px;border-top:1px solid #29404a;display:flex;justify-content:space-between;gap:14px;color:#789399;font-size:9px;line-height:1.6}.footer{display:flex;justify-content:space-between;gap:20px;margin-top:27px;font-size:9px;color:#8c999c;line-height:1.8}.footer-brand{font-weight:650;color:#738788}.empty{font-size:11px;color:#9aa5a6;line-height:1.7;padding:7px 0}.login-page{min-height:100vh;display:grid;place-items:center;padding:30px;background:radial-gradient(ellipse at 50% 15%,#e8efdf,transparent 55%),var(--paper)}.login-shell{width:100%;max-width:430px}.login-brand{justify-content:center;margin-bottom:34px}.login-card{background:#fff;border:1px solid #dce5db;border-radius:17px;padding:34px;box-shadow:0 16px 60px #162d3710}.login-card h1{font-size:25px;letter-spacing:-.8px;line-height:1.25;margin-top:15px}.login-copy{font-size:12px;line-height:1.8;color:var(--muted);margin:13px 0 27px}.login-card label{display:block;font-size:11px;font-weight:650;margin-bottom:9px}.login-card input{width:100%;padding:13px 14px;border:1px solid #dbe3da;background:#fafbf8;border-radius:7px;color:var(--ink);font-size:16px}.login-card input:focus{border-color:#168b6e}.login-card .primary{margin-top:15px;width:100%;background:#087d63;color:#fff;border-color:#087d63;justify-content:space-between}.login-card .primary:hover{background:#096b57}.login-error{min-height:18px;margin:12px 0 0;color:var(--red);font-size:11px;line-height:1.6}.login-foot{font-size:10px;line-height:1.8;text-align:center;color:#8a9a9a;margin:23px 0 0}.login-route{display:flex;gap:9px;align-items:center;color:#5c8270;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-weight:700}.login-route .dot{background:#138462;width:5px;height:5px}
@media(min-width:1500px){.shell{padding-top:36px}.step{padding-top:17px;padding-bottom:17px}}
@media(max-width:1100px){.shell{padding:25px}.topbar-inner{padding:0 25px;gap:26px}.brand-sub{display:none}.content-grid{grid-template-columns:minmax(0,1fr) 290px;gap:18px}.card-header{padding:20px 18px 17px}.side-body{padding:0 18px 19px}.step{padding-left:18px;padding-right:18px;gap:10px;grid-template-columns:25px minmax(0,1fr) 60px 67px}.pipeline-columns{padding-left:54px;padding-right:18px;gap:10px;grid-template-columns:minmax(0,1fr) 60px 67px}.step-detail{font-size:9px}.metric{padding:21px}.route-city{font-size:29px}.route{gap:20px}.route-arrow{width:50px}.hero{padding:27px}.metric-value{font-size:31px}.metric-active{font-size:17px}}
@media(max-width:900px){.content-grid{grid-template-columns:minmax(0,1fr)}.sidebar{grid-template-columns:1fr 1fr;gap:18px}.memory-card{grid-column:1/-1}.chart-box{height:110px}.notification-card{grid-column:1/-1}.notification-card .admins{display:flex;flex-wrap:wrap;gap:18px}.top-right{gap:16px}.hero{min-height:190px}.metric{padding:21px 18px}.step-detail{font-size:10px}.step{padding:15px 23px;grid-template-columns:25px minmax(0,1fr) 70px 80px;gap:15px}.pipeline-columns{padding-left:64px;padding-right:23px;grid-template-columns:minmax(0,1fr) 70px 80px;gap:15px}.card-header{padding:22px 23px 18px}.side-body{padding:0 23px 22px}}
@media(max-width:620px){.topbar{height:66px}.topbar-inner{padding:0 18px;gap:18px}.brand{font-size:18px;gap:9px}.brand-mark{height:31px;width:31px;font-size:24px}.nav-current{display:none}.top-right{gap:13px}.avatar{display:none}.link{font-size:11px}.shell{padding:23px 16px}.page-heading{align-items:flex-start;margin-bottom:20px;gap:10px}h1{font-size:24px}.breadcrumb{font-size:10px;margin-bottom:11px}.page-subtitle{max-width:230px;font-size:11px}.connection{font-size:0;margin-top:30px}.connection .dot{width:7px;height:7px}.hero{padding:24px;display:block;border-radius:12px}.hero-kicker{font-size:9px;margin-bottom:22px}.route{gap:18px}.route-city{font-size:28px}.route-arrow{flex:1;min-width:25px;max-width:75px}.route-label{font-size:9px}.hero-copy{font-size:10px;margin:21px 0}.hero-action{text-align:left;display:grid;grid-template-columns:1fr;gap:0}.hero-action .primary{width:100%;justify-content:space-between}.hero-action-note{text-align:center;font-size:9px}.run-label{display:none}.metrics{grid-template-columns:1fr 1fr;margin:15px 0 19px;border-radius:10px}.metric{padding:19px 17px}.metric:nth-child(3){grid-column:1/-1;border-top:1px solid var(--line);border-left:0;display:grid;grid-template-columns:1fr auto;gap:0 14px;align-items:center;padding-top:15px;padding-bottom:15px}.metric:nth-child(3) .metric-label{grid-column:1/-1}.metric:nth-child(3) .metric-active{margin:8px 0 0;white-space:normal}.metric:nth-child(3) .metric-note{margin-top:8px;text-align:right}.metric-icon{font-size:14px}.metric-label{font-size:9px;letter-spacing:.8px}.metric-value{font-size:28px;letter-spacing:-1px;margin:10px 0 5px}.metric-note{font-size:9px}.metric-active{font-size:15px;letter-spacing:-.3px}.sidebar{grid-template-columns:minmax(0,1fr)}.memory-card,.notification-card{grid-column:auto}.notification-card .admins{display:grid;gap:10px}.card-header{padding:20px 17px 17px;gap:10px}.card-title{font-size:13px}.card-subtitle{font-size:9px}.badge{font-size:9px;padding:5px 7px}.pipeline-summary{padding:0 17px 17px;gap:9px}.pipeline-count{font-size:9px}.pipeline-columns{padding:11px 17px 10px 49px;grid-template-columns:minmax(0,1fr) 57px 58px;gap:8px;font-size:8px;letter-spacing:.3px}.step{grid-template-columns:22px minmax(0,1fr) 57px 58px;gap:8px;padding:15px 17px}.step-icon{width:22px;height:22px;font-size:9px}.step-name{font-size:10px}.step-detail{font-size:9px;line-height:1.5}.step-time{font-size:10px}.step-memory{font-size:9px}.step-track{width:43px}.pipeline-foot{padding:12px 17px;font-size:8px}.side-body{padding:0 17px 20px}.log-actions{gap:9px}.logs-card .card-header{padding:17px}.autoscroll{font-size:9px}.small-button{font-size:9px}.log{padding:17px;font-size:9px;min-height:170px;max-height:320px}.logs-foot{padding:10px 17px;font-size:8px}.footer{display:block;margin-top:23px;font-size:9px}.footer>span{display:block;margin-top:4px}.memory-values{padding:0 17px}.chart-box{margin-left:17px;margin-right:17px}.chart-scale{margin-left:17px;margin-right:17px}.memory-foot{padding:12px 17px}.login-card{padding:28px}.login-page{padding:20px}}
@media(max-width:360px){.hero{padding:21px 18px}.route{gap:12px}.route-city{font-size:25px}.route-arrow{min-width:21px}.metric-value{font-size:24px}.step{gap:6px;padding-left:13px;padding-right:13px;grid-template-columns:20px minmax(0,1fr) 52px 54px}.pipeline-columns{padding-left:39px;padding-right:13px;grid-template-columns:minmax(0,1fr) 52px 54px;gap:6px}}

.infrastructure{margin:0 0 24px}.infrastructure-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:0 0 13px}.infrastructure-heading h2{font-size:15px;letter-spacing:-.3px;margin:0}.infrastructure-heading p{font-size:10px;color:var(--muted);margin:6px 0 0}.resource-refresh{font:9px var(--mono);color:#819291;white-space:nowrap}.resource-hosts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.host-card{border:1px solid var(--line);background:#fff;border-radius:12px;overflow:hidden;min-width:0}.host-head{display:flex;align-items:center;gap:12px;padding:20px 22px 18px}.host-symbol{display:grid;place-items:center;height:34px;width:34px;border-radius:9px;border:1px solid #e0e9e2;background:#f3f7f0;font-size:16px;color:#527666;flex:none}.host-title{min-width:0}.host-title h3{font-size:14px;font-weight:650;letter-spacing:-.3px;margin:0}.host-role{font-size:10px;color:#8b979b;margin:5px 0 0;overflow-wrap:anywhere}.host-head .badge{margin-left:auto}.host-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:0 22px;gap:18px}.host-stat-label{display:block;color:#6f8286;font-size:9px;font-weight:650;line-height:1.4;white-space:nowrap}.host-value{display:block;font:22px/1.35 var(--mono);letter-spacing:-1px;color:#23413e;margin:8px 0 5px;white-space:nowrap}.host-value .unit{font-size:11px;letter-spacing:-.25px}.host-value.unmeasured{font-size:13px;line-height:2.3;letter-spacing:0}.host-capacity{font-size:9px;color:#8c999c;line-height:1.5;display:block;min-height:27px}.capacity-track{height:3px;overflow:hidden;border-radius:3px;background:#eef2ed;margin-top:8px}.capacity-track span{display:block;background:#60a88a;height:100%;border-radius:3px;transition:width .3s}.capacity-track.cpu span{background:#829f9a}.capacity-track.warning span{background:#cf9742}.capacity-track.critical span{background:#bd6470}.host-network{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:19px 22px 0;padding:13px 0;border-top:1px solid #edf1eb}.network-metric{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}.network-label{font-size:9px;color:#7f9094;white-space:nowrap}.network-label span{font-size:13px;color:#37816b;margin-right:5px}.network-value{font:11px var(--mono);color:#48646a;white-space:nowrap}.host-observation{display:flex;justify-content:space-between;gap:12px;padding:0 22px 14px;color:#8a989b;font-size:9px;line-height:1.6;min-height:28px}.host-observation .stale{color:#a36a25}.host-error{padding:10px 22px;margin:0;background:#fff8ed;border-top:1px solid #f3e7ce;color:#916222;font-size:10px;line-height:1.6;overflow-wrap:anywhere}.host-error[hidden]{display:none}.host-details{border-top:1px solid #e8eee6;background:#fcfcfa}.host-details summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;padding:13px 22px;color:#547168;font-size:10px;font-weight:600;min-height:42px}.host-details summary::-webkit-details-marker{display:none}.host-details summary:after{content:'+';font-size:14px;font-weight:400;color:#7d938b}.host-details[open] summary:after{content:'−'}.resource-details-body{padding:0 22px 19px}.resource-details-body h4{margin:16px 0 7px;font-size:9px;font-weight:700;letter-spacing:.65px;text-transform:uppercase;color:#688078}.resource-details-body h4:first-child{margin-top:3px}.resource-table{border-collapse:collapse;width:100%;font-size:9px;color:#708186;line-height:1.6}.resource-table th{text-align:left;font-weight:500;color:#708186}.resource-table th,.resource-table td{padding:7px 0;border-bottom:1px solid #eaf0e6;vertical-align:top;overflow-wrap:anywhere}.resource-table td{text-align:right;font-family:var(--mono);color:#526d73;padding-left:12px}.resource-table tr:last-child th,.resource-table tr:last-child td{border-bottom:0}.resource-detail-note{font-size:9px;line-height:1.7;color:#8a9897;margin:9px 0 0}.resource-interface{border-top:1px solid #e8eee5;padding-top:8px;margin-top:9px}.resource-interface>strong{font:10px var(--mono);color:#587970}.resource-provider{display:flex;align-items:flex-start;gap:10px;background:#eef2e9;border:1px solid #e4e9de;border-radius:8px;padding:11px 15px;margin-top:12px;color:#788777;font-size:9px;line-height:1.7}.resource-provider strong{color:#596e59;font-size:10px;font-weight:650;flex:none}.resource-provider p{margin:0}.resource-provider .badge{padding:2px 5px;margin:0 7px 0 0;vertical-align:baseline;font-size:8px}
@media(max-width:1100px){.host-head{padding:18px}.host-metrics{padding:0 18px;gap:12px}.host-value{font-size:19px}.host-network{margin-left:18px;margin-right:18px;gap:12px}.host-observation{padding-left:18px;padding-right:18px}.network-metric{display:block}.network-value{display:block;margin-top:6px}.host-details summary{padding-left:18px;padding-right:18px}.resource-details-body{padding-left:18px;padding-right:18px}}
@media(max-width:760px){.resource-hosts{grid-template-columns:minmax(0,1fr);gap:14px}.host-value{font-size:23px}.host-metrics{gap:20px}.network-metric{display:flex}.network-value{margin:0}.resource-provider{display:block}.resource-provider p{margin-top:5px}.infrastructure-heading p{max-width:260px;line-height:1.6}}
@media(max-width:420px){.infrastructure-heading{gap:10px}.resource-refresh{font-size:8px}.infrastructure-heading h2{font-size:14px}.infrastructure-heading p{font-size:9px;max-width:205px}.host-metrics{gap:12px}.host-value{font-size:19px;letter-spacing:-.7px}.host-stat-label{font-size:8px}.host-capacity{font-size:8px}.host-head{gap:10px}.host-title h3{font-size:13px}.host-role{font-size:9px}.network-value{font-size:10px}.network-label{font-size:8px}.host-observation{font-size:8px}.host-details summary{font-size:9px}.resource-provider{font-size:8px}}

.release-actions{display:flex;align-items:stretch;justify-content:flex-end;gap:9px}.secondary{border:1px solid #51716f;background:#ffffff06;border-radius:8px;color:#bad1ca;min-height:45px;padding:12px 14px;font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:10px;transition:background .15s}.secondary:hover:not(:disabled){background:#ffffff10;border-color:#83a79a}.rollback-note{font-size:9px;color:#8aa89e;line-height:1.5;max-width:355px;margin:7px 0 0 auto;overflow-wrap:anywhere}.provider-heading{margin-top:22px}.provider-heading h3{font-size:12px;font-weight:650;letter-spacing:-.2px;margin:0}.provider-heading p{max-width:none}.provider-card .host-head{padding-bottom:14px}.provider-symbol{font-size:17px;background:#f2f4f8;border-color:#e3e8ed;color:#6a7e8f}.provider-summary{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 22px 15px}.provider-summary-label{display:block;font-size:9px;color:#8a9699;margin-bottom:7px}.provider-summary-value{display:block;font-size:11px;font-weight:600;line-height:1.6;color:#4b6867}.provider-balance{border-top:1px solid #edf0e8;margin:0 22px 13px;padding-top:11px;font-size:9px;color:#82908e;line-height:1.6;display:flex;gap:12px;justify-content:space-between}.provider-balance strong{font-weight:600;color:#6c7874;text-align:right}.provider-section{border-top:1px solid #e5ece3;margin-top:9px}.provider-section>summary{padding:13px 0;font-size:10px;color:#4d6c63;gap:12px;justify-content:flex-start}.provider-section>summary .badge{margin-left:auto;font-size:8px;padding:3px 6px}.provider-section>summary:after{width:10px;flex:none;text-align:center}.provider-section:first-child{margin-top:0}.provider-section-content{padding-bottom:8px}.provider-item{padding-top:11px;margin-top:11px;border-top:1px solid #e6ebe2}.provider-item:first-child{margin-top:0;padding-top:0;border-top:0}.provider-item-title{font-size:11px;line-height:1.5;color:#3c6258;overflow-wrap:anywhere;margin:0 0 5px}.provider-item-meta{font-size:9px;line-height:1.65;color:#8a9594;margin:0 0 8px;overflow-wrap:anywhere}.provider-metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.provider-metric{background:#f1f5ed;border:1px solid #e8ede3;border-radius:6px;padding:10px;min-width:0}.provider-metric-label{font-size:8px;color:#708479;line-height:1.5;display:block}.provider-metric strong{display:block;font:12px/1.65 var(--mono);color:#42655c;margin:3px 0}.provider-metric small{display:block;font-size:8px;line-height:1.6;color:#89968e;overflow-wrap:anywhere}.provider-unavailable{font-size:9px;line-height:1.7;color:#8d795b;margin:2px 0 10px;overflow-wrap:anywhere}.provider-empty{font-size:9px;line-height:1.7;color:#84928d;margin:2px 0 10px}.provider-table-wrap{max-height:320px;overflow:auto;scrollbar-color:#ccd9ce transparent}.provider-usage-table{table-layout:fixed}.provider-usage-table th{width:63%;padding-right:10px;line-height:1.5}.provider-usage-table td{width:37%}.provider-usage-table small{display:block;font-size:8px;color:#8c9997;font-family:inherit;font-weight:400;margin-top:4px;line-height:1.6}.provider-usage-table th strong{font-size:9px;font-weight:600;color:#526f65}.provider-scope{padding:9px 0 3px;font-size:9px;line-height:1.7;color:#84948c;margin:0}.provider-free-note{margin:12px 0 0;padding:11px 12px;border:1px solid #e5eadf;border-radius:6px;background:#f0f4e9;font-size:9px;line-height:1.7;color:#798970}.provider-free-note strong{display:block;color:#5e7759;font-weight:600;margin-bottom:3px}
@media(max-width:900px) and (min-width:621px){.release-actions{flex-direction:column}.hero-action .primary{justify-content:space-between}.rollback-note{max-width:220px}}
@media(max-width:620px){.release-actions{display:grid;grid-template-columns:minmax(0,1fr)}.release-actions .secondary{justify-content:space-between}.rollback-note{max-width:none;margin:7px 0 0;text-align:center}}
.ui-icon{display:inline-block;width:16px;height:16px;vertical-align:middle;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round;flex:none}.host-symbol .ui-icon{width:22px;height:22px;stroke-width:1.45}.host-stat-label{display:flex;align-items:center;gap:5px}.host-stat-label .ui-icon{width:12px;height:12px;color:#7f9b8f;stroke-width:1.6}.network-label{display:inline-flex;align-items:center;gap:6px}.network-label .ui-icon{height:14px;width:14px;color:#36876d}.resource-details-body h4 .ui-icon{height:13px;width:13px;margin-right:6px;color:#749181}.provider-section>summary>.ui-icon{height:14px;width:14px;color:#779589}.provider-metric-label{display:flex;align-items:center;gap:5px}.provider-metric-label .ui-icon{height:12px;width:12px;color:#819b89}.metric-icon .ui-icon{width:18px;height:18px}.provider-item-title{letter-spacing:0!important;text-transform:none!important;font-size:11px!important}
@media(max-width:1100px){.provider-summary{padding-left:18px;padding-right:18px}.provider-balance{margin-left:18px;margin-right:18px}}
@media(max-width:420px){.provider-heading p{max-width:225px}.provider-summary-value{font-size:10px}.provider-summary-label,.provider-balance{font-size:8px}.provider-metric-grid{gap:6px}.provider-metric{padding:8px}.provider-metric strong{font-size:11px}}
.host-capacity{white-space:pre-line}.host-utilization{display:block;margin-top:8px;font:9px/1.5 var(--mono);color:#547a69;white-space:nowrap}.host-utilization.warning{color:#9a6c20}.host-utilization.critical{color:#b73b49;font-weight:650}.host-utilization.unknown{color:#929d9c;font-family:inherit}.host-metrics>.critical .host-value{color:#b73b49}.capacity-track{margin-top:5px;height:4px}.resource-thresholds{display:flex;align-items:center;flex-wrap:wrap;gap:14px;color:#87958b;font-size:9px;line-height:1.6;margin:10px 2px 0}.resource-thresholds span{display:inline-flex;align-items:center;gap:5px}.resource-thresholds i{width:6px;height:6px;display:inline-block;border-radius:50%;background:#cf9742}.resource-thresholds .critical i{background:#bd6470}@media(max-width:420px){.host-utilization{font-size:8px}.host-utilization.unknown{font-size:7px}.resource-thresholds{font-size:8px;gap:10px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

function dashboardClient() {
  const $ = id => document.getElementById(id);
  const safe = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  function icon(name) {
    const drawings = {
      cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"/>',
      memory: '<rect x="3" y="6" width="18" height="11" rx="2"/><path d="M6 17v3m4-3v3m4-3v3m4-3v3"/><rect x="6" y="9" width="4" height="5" rx=".5"/><rect x="14" y="9" width="4" height="5" rx=".5"/>',
      disk: '<path d="m4 4-2 10v5a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-5L20 4zM2 14h20"/><path d="M6 17h.01M9 17h.01M16 17h3"/>',
      partitions: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 10h18M11 10v11M7 7h.01M10 7h.01M15 14h3m-3 3h3"/>',
      database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
      ingress: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
      egress: '<path d="M12 15V3m-4 4 4-4 4 4M4 16v4h16v-4"/>',
      cloud: '<path d="M6 18a4.5 4.5 0 0 1-.8-8.9 7 7 0 0 1 13.6 0A4.5 4.5 0 0 1 18 18H6Z"/><path d="M8 18v3m8-3v3m-4-3v3"/>',
      server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5M7 10v4m10-4v4"/>',
      network: '<rect x="8" y="2" width="8" height="6" rx="1.5"/><rect x="2" y="16" width="7" height="6" rx="1.5"/><rect x="15" y="16" width="7" height="6" rx="1.5"/><path d="M12 8v4M5.5 16v-4h13v4"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
      activity: '<path d="M2 12h4l3-7 6 14 3-7h4"/>',
      usage: '<path d="M4 4v16h17M8 15v-4m5 4V7m5 8v-6"/>',
      quota: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--surface)"/><circle cx="15" cy="17" r="2.5" fill="var(--surface)"/>',
    };
    return '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (drawings[name] || drawings.server) + '</svg>';
  }
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const bytes = value => !number(value) ? '—' : value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GiB' : value >= 1024 ** 2 ? (value / 1024 ** 2).toFixed(1) + ' MiB' : value >= 1024 ? Math.round(value / 1024) + ' KiB' : Math.round(value) + ' B';
  const duration = value => {
    if (!number(value)) return '—';
    if (value > 0 && value < 1000) return Math.max(1, Math.round(value)) + 'ms';
    const total = Math.floor(value / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
    return hours ? hours + 'h ' + String(minutes).padStart(2, '0') + 'm ' + String(seconds).padStart(2, '0') + 's' : minutes ? minutes + 'm ' + String(seconds).padStart(2, '0') + 's' : seconds + 's';
  };
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : '#'; } catch { return '#'; } };
  const statusNames = { idle: 'Ready to release', running: 'Release in progress', succeeded: 'Release successful', failed: 'Release failed', interrupted: 'Release interrupted' };
  const stepStatuses = new Set(['pending', 'running', 'done', 'failed', 'skipped']);
  let snapshot = null, receivedAt = 0, connected = false, fetching = false, actionPending = false, actionKind = null, sessionExpired = false, lastLog = null, actionMessage = '', logDownloadUrl = null;

  function pill(element, level, label) {
    element.className = 'badge ' + (['green', 'orange', 'red'].includes(level) ? level : '');
    element.innerHTML = '<span class="dot" aria-hidden="true"></span>' + safe(label);
  }
  function banner(message, expired = false) {
    $('notice').hidden = !message;
    $('notice').textContent = message;
    if (expired) {
      const link = document.createElement('a');
      link.href = '/'; link.textContent = 'Sign in again';
      $('notice').append(' ', link);
    }
  }
  function connection(ok) {
    connected = ok;
    $('connection').className = 'connection ' + (ok ? 'connected' : 'disconnected');
    $('connectionLabel').textContent = sessionExpired ? 'Session expired' : ok ? 'Live · updates every 2s' : snapshot ? 'Connection interrupted' : 'Connecting to Hyderabad';
    $('connection').title = $('connectionLabel').textContent;
    updateActions();
    if (ok) banner(actionMessage);
  }
  function rollbackVersion() {
    const version = snapshot?.rollback?.version;
    return typeof version === 'string' ? version : version?.displayVersion || version?.version || null;
  }
  function updateActions() {
    const running = snapshot?.release?.status === 'running', rollingBack = snapshot?.release?.kind === 'rollback';
    const disabled = !connected || sessionExpired || actionPending || running;
    $('release').disabled = disabled;
    $('rollback').disabled = disabled || snapshot?.rollback?.available !== true;
    $('releaseLabel').textContent = actionPending && actionKind === 'build' ? 'Requesting release…' : running && !rollingBack ? 'Release in progress' : 'Build & deploy';
    $('rollbackLabel').textContent = actionPending && actionKind === 'rollback' ? 'Requesting rollback…' : running && rollingBack ? 'Restoring release…' : 'Roll back';
    const version = rollbackVersion();
    const note = snapshot?.rollback?.available ? 'One fallback available' + (version ? ' · ' + version : '') : snapshot?.rollback?.reason || 'Checking for a previous release';
    $('rollbackNote').textContent = note;
    $('rollback').title = snapshot?.rollback?.available ? 'Restore previous release' + (version ? ' · ' + version : '') : note;
    $('rollbackNote').title = snapshot?.rollback?.checkedAt ? 'Last checked ' + date(snapshot.rollback.checkedAt) : '';
  }
  function expireSession() {
    sessionExpired = true;
    connection(false);
    banner('Your console session has expired. Sign in to see live status and release controls.', true);
  }
  function elapsed(record, running) {
    let base = number(record?.durationMs) ? record.durationMs : null;
    if (base === null && record?.startedAt) {
      const finish = record.finishedAt || snapshot?.serverTime;
      const difference = Date.parse(finish) - Date.parse(record.startedAt);
      if (Number.isFinite(difference) && difference >= 0) base = difference;
    }
    if (base === null) return null;
    return base + (running && connected ? Math.max(0, performance.now() - receivedAt) : 0);
  }
  function tick() {
    if (!snapshot) return;
    tickResources();
    const release = snapshot.release, running = release.status === 'running';
    const total = elapsed(release, running);
    $('totalTime').textContent = duration(total ?? (release.status === 'idle' ? 0 : null));
    const times = (release.steps || []).map(step => elapsed(step, running && step.status === 'running'));
    const max = Math.max(1, ...times.filter(number));
    times.forEach((time, index) => {
      const value = $('stepTime' + index), track = $('stepTrack' + index);
      if (value) value.textContent = duration(time);
      if (track) track.style.width = number(time) ? Math.min(100, time / max * 100) + '%' : '0%';
    });
    const activeIndex = (release.steps || []).findIndex(step => step.status === 'running');
    $('activeTime').textContent = activeIndex >= 0 ? duration(times[activeIndex]) + ' elapsed in this step' : release.status === 'idle' ? 'Waiting for the next release' : release.status === 'succeeded' ? 'All release stages finished' : 'No step is currently running';
    $('logStatus').textContent = running ? (connected ? 'Streaming release output' : 'Connection lost · output paused') : release.status === 'idle' ? 'Output will appear when a release starts' : 'Release finished' + (release.exitCode != null ? ' · exit ' + release.exitCode : '');
  }
  function renderSteps(steps) {
    $('timeline').innerHTML = steps.map((step, index) => {
      const status = stepStatuses.has(step.status) ? step.status : 'pending';
      const icon = status === 'done' ? '✓' : status === 'failed' ? '!' : status === 'skipped' ? '–' : status === 'running' ? '<span class="spinner" aria-hidden="true"></span>' : String(index + 1).padStart(2, '0');
      return '<li class="step ' + status + '"><span class="step-icon" aria-hidden="true">' + icon + '</span><div><span class="step-name">' + safe(step.label) + '<span class="sr-only"> — ' + safe(status) + '</span></span><span class="step-detail">' + safe(step.detail) + '</span></div><div class="step-time-wrap"><span class="step-time" id="stepTime' + index + '">—</span><span class="step-track" aria-hidden="true"><span id="stepTrack' + index + '"></span></span></div><span class="step-memory" title="Peak sampled process-tree RSS during this step">' + bytes(step.peakRssBytes) + '</span></li>';
    }).join('') || '<li class="empty" style="padding:20px 23px">No pipeline steps reported.</li>';
    const complete = steps.filter(step => step.status === 'done' || step.status === 'skipped').length;
    $('pipelineCount').textContent = complete + ' / ' + steps.length + ' complete';
    $('pipelineProgress').style.width = (steps.length ? complete / steps.length * 100 : 0) + '%';
    $('pipelineProgress').parentElement.setAttribute('aria-valuenow', String(complete));
    $('pipelineProgress').parentElement.setAttribute('aria-valuemax', String(steps.length || 1));
  }
  function memoryChart(metrics) {
    const samples = (Array.isArray(metrics?.samples) ? metrics.samples : []).filter(item => number(item.elapsedMs) && number(item.rssBytes));
    const available = Boolean(metrics?.available);
    $('peakMemory').textContent = bytes(metrics?.peakRssBytes);
    $('currentMemory').textContent = bytes(snapshot.release.status === 'running' ? metrics?.currentRssBytes : samples.at(-1)?.rssBytes);
    $('memoryLabel').textContent = snapshot.release.status === 'running' ? 'current process RSS' : 'last sampled process RSS';
    $('memoryStatus').textContent = available ? '1s sampling' : 'No live sample';
    $('peakMemoryNote').textContent = number(metrics?.peakRssBytes) ? 'Peak sampled across the build process tree' : snapshot.release.status === 'idle' ? 'Measured during the next build' : 'Memory measurement unavailable';
    if (!samples.length) {
      $('memoryChart').innerHTML = '<div class="chart-empty">' + (snapshot.release.status === 'idle' ? 'Memory history appears during a build' : 'No memory samples available') + '</div>';
      $('chartStart').textContent = '—'; $('chartEnd').textContent = '—';
      return;
    }
    const width = 600, height = 100, bottom = 94, top = 6;
    const first = samples[0].elapsedMs, last = samples[samples.length - 1].elapsedMs;
    const max = Math.max(1, ...samples.map(item => item.rssBytes));
    const coordinates = samples.map(item => [samples.length === 1 ? width / 2 : (item.elapsedMs - first) / Math.max(1, last - first) * width, bottom - item.rssBytes / max * (bottom - top)]);
    const points = coordinates.map(([x, y]) => x.toFixed(2) + ',' + y.toFixed(2)).join(' ');
    const [lastX, lastY] = coordinates[coordinates.length - 1];
    const area = coordinates[0][0].toFixed(2) + ',' + bottom + ' ' + points + ' ' + lastX.toFixed(2) + ',' + bottom;
    $('memoryChart').innerHTML = '<svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label="' + safe('Sampled build process memory. ' + samples.length + ' samples; visible maximum ' + bytes(max) + '.') + '"><defs><linearGradient id="memoryFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#47aa83" stop-opacity=".19"/><stop offset="100%" stop-color="#47aa83" stop-opacity=".015"/></linearGradient></defs><polygon points="' + area + '" fill="url(#memoryFill)"/><polyline points="' + points + '" fill="none" stroke="#218366" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><circle cx="' + lastX.toFixed(2) + '" cy="' + lastY.toFixed(2) + '" r="2.7" fill="#218366"/></svg>';
    $('chartStart').textContent = duration(first);
    $('chartEnd').textContent = duration(last) + ' elapsed';
  }
  const resourceHostDefinitions = [
    { id: 'hyderabad', label: 'Hyderabad', role: 'Build host' },
    { id: 'mumbai', label: 'Mumbai', role: 'Production host' },
  ];
  const resourceDetailKeys = new Map();
  const providerDetailKeys = new Map();
  const hostElement = (id, field) => $('host-' + id + '-' + field);
  const providerElement = (id, field) => $('provider-' + id + '-' + field);
  const resourceBytes = value => number(value) && value >= 1024 ** 4 ? (value / 1024 ** 4).toFixed(2) + ' TiB' : bytes(value);
  const rate = value => number(value) ? (value > 0 && value < 1 ? value.toFixed(2) + ' B' : resourceBytes(value)) + '/s' : null;
  const percent = value => number(value) ? value.toFixed(1) + '%' : null;
  const proportion = (part, whole) => number(part) && number(whole) && whole > 0 ? part / whole * 100 : null;
  const sampleClock = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  function createResourceCards() {
    $('resourceHosts').innerHTML = resourceHostDefinitions.map(host => {
      const id = 'host-' + host.id + '-';
      return '<article class="host-card" aria-labelledby="' + id + 'title"><div class="host-head"><span class="host-symbol" aria-hidden="true">' + icon('server') + '</span><div class="host-title"><h3 id="' + id + 'title">' + host.label + '</h3><p id="' + id + 'role" class="host-role">' + host.role + '</p></div><span id="' + id + 'status" class="badge">Connecting</span></div><div class="host-metrics"><div><span class="host-stat-label">' + icon('cpu') + 'CPU used</span><strong id="' + id + 'cpu" class="host-value">—</strong><span id="' + id + 'cpuCapacity" class="host-capacity">Awaiting host sample</span><span id="' + id + 'cpuUsage" class="host-utilization unknown">Usage unavailable</span><div id="' + id + 'cpuTrack" class="capacity-track cpu" aria-hidden="true"><span style="width:0%"></span></div></div><div><span class="host-stat-label">' + icon('memory') + 'RAM available</span><strong id="' + id + 'memory" class="host-value">—</strong><span id="' + id + 'memoryCapacity" class="host-capacity">Total —</span><span id="' + id + 'memoryUsage" class="host-utilization unknown">Usage unavailable</span><div id="' + id + 'memoryTrack" class="capacity-track" aria-hidden="true"><span style="width:0%"></span></div></div><div><span id="' + id + 'diskLabel" class="host-stat-label">' + icon('disk') + 'Root disk free</span><strong id="' + id + 'disk" class="host-value">—</strong><span id="' + id + 'diskCapacity" class="host-capacity">Total —</span><span id="' + id + 'diskUsage" class="host-utilization unknown">Usage unavailable</span><div id="' + id + 'diskTrack" class="capacity-track" aria-hidden="true"><span style="width:0%"></span></div></div></div><div class="host-network"><div class="network-metric"><span class="network-label">' + icon('ingress') + 'Ingress</span><strong id="' + id + 'ingress" class="network-value">—</strong></div><div class="network-metric"><span class="network-label">' + icon('egress') + 'Egress</span><strong id="' + id + 'egress" class="network-value">—</strong></div></div><div class="host-observation"><span id="' + id + 'sampled">No observation yet</span><span id="' + id + 'age">Waiting for sample</span></div><p id="' + id + 'error" class="host-error" hidden></p><details class="host-details"><summary>Storage, services &amp; network details</summary><div id="' + id + 'details" class="resource-details-body"><p class="resource-detail-note">Waiting for host measurements.</p></div></details></article>';
    }).join('');
  }
  function resourceHosts() {
    const resources = snapshot?.resources;
    return resourceHostDefinitions.map(definition => (resources?.hosts || []).find(host => host.id === definition.id) || { ...definition, status: resources ? 'unavailable' : 'loading', checkedAt: null, snapshot: null });
  }
  function resourceAge(host) {
    if (!host.checkedAt) return null;
    const age = Date.parse(snapshot?.serverTime) - Date.parse(host.checkedAt);
    return Number.isFinite(age) ? Math.max(0, age) + Math.max(0, performance.now() - receivedAt) : null;
  }
  function resourcePressure(sample) {
    const disk = (Array.isArray(sample?.disks) ? sample.disks : []).find(item => item.path === '/');
    const values = [sample?.cpu?.usagePercent, proportion(sample?.memory?.usedBytes, sample?.memory?.totalBytes), proportion(disk?.usedBytes, disk?.totalBytes)].filter(number);
    return values.length ? Math.max(...values) : null;
  }
  function tickResources() {
    const interval = number(snapshot?.resources?.sampleIntervalMs) ? snapshot.resources.sampleIntervalMs : 10000;
    for (const host of resourceHosts()) {
      const age = resourceAge(host), stale = !connected || (age !== null && age > Math.max(interval * 3, 30000));
      const ageNode = hostElement(host.id, 'age');
      if (!ageNode) continue;
      ageNode.className = stale ? 'stale' : '';
      ageNode.textContent = age === null ? 'Waiting for sample' : (stale ? 'Stale · ' : '') + duration(age) + ' ago';
      const pressure = resourcePressure(host.snapshot);
      const status = host.status === 'available' && host.snapshot ? stale ? 'Stale' : pressure !== null && pressure >= 95 ? 'Attention' : pressure !== null && pressure >= 85 ? 'High usage' : 'Observed' : host.status === 'loading' ? 'Measuring' : 'Unavailable';
      pill(hostElement(host.id, 'status'), status === 'Observed' ? 'green' : status === 'Attention' ? 'red' : status === 'Measuring' ? '' : 'orange', status);
    }
    tickProviders();
  }
  function hostValue(id, field, value) {
    const element = hostElement(id, field);
    const numeric = /^(\d+(?:\.\d+)?)(.*)$/.exec(value);
    element.className = 'host-value' + (value === 'Measuring' ? ' unmeasured' : '');
    if (numeric) element.innerHTML = safe(numeric[1]) + '<span class="unit">' + safe(numeric[2]) + '</span>';
    else element.textContent = value;
  }
  function capacityTrack(id, field, value) {
    const element = hostElement(id, field);
    const level = value === null ? 'unknown' : value >= 95 ? 'critical' : value >= 85 ? 'warning' : '';
    element.className = 'capacity-track' + (level ? ' ' + level : '');
    element.firstElementChild.style.width = value === null ? '0%' : Math.min(100, Math.max(0, value)) + '%';
    element.parentElement.className = level;
    const label = hostElement(id, field.replace('Track', 'Usage'));
    label.className = 'host-utilization' + (level ? ' ' + level : '');
    label.textContent = value === null ? 'Usage unavailable' : percent(value) + ' used';
    label.title = level === 'critical' ? 'Attention: usage is at least 95%' : level === 'warning' ? 'High usage: at least 85%' : 'Observed percentage used';
  }
  function resourceDetails(host) {
    const sample = host.snapshot;
    if (!sample) return '<p class="resource-detail-note">' + (host.status === 'loading' ? 'Waiting for host measurements.' : 'Host measurements are unavailable.') + '</p>';
    const row = (label, value) => '<tr><th scope="row">' + safe(label) + '</th><td>' + safe(value) + '</td></tr>';
    const table = rows => '<table class="resource-table"><tbody>' + rows + '</tbody></table>';
    const cores = sample.cpu?.logicalCores;
    const loads = Array.isArray(sample.cpu?.loadAverage) ? sample.cpu.loadAverage.map(value => number(value) ? value.toFixed(2) : '—').join(' / ') : '—';
    const uptime = number(sample.uptimeSeconds) ? Math.floor(sample.uptimeSeconds / 86400) + 'd ' + Math.floor(sample.uptimeSeconds % 86400 / 3600) + 'h ' + Math.floor(sample.uptimeSeconds % 3600 / 60) + 'm' : '—';
    let result = '<h4>' + icon('server') + 'Host &amp; capacity</h4>' + table(
      row('Hostname', sample.hostname || '—') + row('Uptime', uptime) + row('Logical CPU cores', number(cores) ? cores : '—') + row('Load average · 1 / 5 / 15 min', loads) + row('Memory · used / total', resourceBytes(sample.memory?.usedBytes) + ' / ' + resourceBytes(sample.memory?.totalBytes)) + row('Memory · available', resourceBytes(sample.memory?.availableBytes)) + row('Swap · free / total', resourceBytes(sample.memory?.swapFreeBytes) + ' / ' + resourceBytes(sample.memory?.swapTotalBytes))
    ) + '<p class="resource-detail-note">Available RAM includes reclaimable cache. Load averages are runnable or waiting tasks, not CPU percentages.</p>';
    const instance = sample.instance;
    result += '<h4>' + icon('cloud') + 'Instance allocation</h4>';
    result += instance ? table(row('Shape', instance.shape || '—') + row('Region', instance.region || '—') + row('OCPUs', number(instance.ocpus) ? instance.ocpus : '—') + row('Provisioned RAM', number(instance.memoryGB) ? instance.memoryGB + ' GB' : '—') + row('Provisioned network bandwidth', number(instance.networkBandwidthGbps) ? instance.networkBandwidthGbps + ' Gbit/s' : '—')) : '<p class="resource-detail-note">Instance allocation unavailable.</p>';
    result += '<p class="resource-detail-note">Provisioned capacity is not current usage or remaining cloud free-tier allowance.</p>';
    result += '<h4>' + icon('partitions') + 'Disk allocation</h4>';
    const diskLayout = Array.isArray(sample.diskLayout) ? sample.diskLayout : [];
    if (!diskLayout.length) result += '<p class="resource-detail-note">' + (Array.isArray(sample.diskLayout) ? 'No whole disks were returned by the host.' : 'Block volume allocation is unavailable.') + '</p>';
    for (const volume of diskLayout) {
      result += '<div class="resource-interface"><strong>' + safe(volume.name || 'Block volume') + '</strong>' + table(row('Volume capacity', resourceBytes(volume.totalBytes)) + row('Assigned to partitions', resourceBytes(volume.partitionedBytes)) + row('Unpartitioned space', resourceBytes(volume.unpartitionedBytes))) + '</div>';
    }
    if (diskLayout.length) result += '<p class="resource-detail-note">Unpartitioned space is outside the existing partitions and is not yet available for files. Volume capacity, partition allocation, and filesystem capacity describe different layers; they must not be added together.</p>';
    result += '<h4>' + icon('disk') + 'Mounted filesystems</h4>';
    const disks = Array.isArray(sample.disks) ? sample.disks : [];
    result += disks.length ? table(disks.map(disk => row(disk.path || 'Filesystem', resourceBytes(disk.availableBytes) + ' free / ' + resourceBytes(disk.totalBytes) + ' total') + row('Used on ' + (disk.path || 'filesystem'), resourceBytes(disk.usedBytes))).join('')) : '<p class="resource-detail-note">Filesystem measurements unavailable.</p>';
    if (disks.length) result += '<p class="resource-detail-note">Each mount is reported separately. The main disk card shows the root filesystem (/); other mounted filesystems have their own usage and available space.</p>';
    result += '<h4>' + icon('memory') + 'Service memory controls</h4>';
    const services = Array.isArray(sample.services) ? sample.services : [];
    if (!services.length) result += '<p class="resource-detail-note">Service memory measurements unavailable.</p>';
    for (const service of services) {
      result += '<div class="resource-interface"><strong>' + safe(service.name || 'Service') + '</strong>' + table(row('Status', service.status || 'Unavailable') + row('Current / peak memory', resourceBytes(service.memoryBytes) + ' / ' + resourceBytes(service.peakMemoryBytes)) + row('Memory limit', service.memoryLimitBytes === null ? 'No reported limit' : resourceBytes(service.memoryLimitBytes)) + row('Cumulative CPU time', number(service.cpuUsageNanoseconds) ? duration(service.cpuUsageNanoseconds / 1000000) : '—')) + '</div>';
    }
    if (services.length) result += '<p class="resource-detail-note">Service memory comes from Linux control groups, including memory charged to the service. It differs from the process RSS below; CPU time is a cumulative counter.</p>';
    result += '<h4>' + icon('memory') + 'Local service memory</h4>';
    const names = { postgres: 'PostgreSQL', mysql: 'MySQL', redis: 'Redis', chessd: 'Chess server' };
    result += table(Object.entries(names).map(([key, label]) => {
      const process = sample.processes?.[key];
      const value = !process ? 'Unavailable' : process.count === 0 ? 'No local process' : resourceBytes(process.rssBytes) + (number(process.count) ? ' · ' + process.count + ' process' + (process.count === 1 ? '' : 'es') : '');
      return row(label, value);
    }).join(''));
    result += '<p class="resource-detail-note">Sampled process RSS on this host. Shared pages may be counted more than once. These are local processes. ChessAlive uses Oracle Autonomous Database in Mumbai; no local database process does not mean the managed database is absent. Its storage and utilization require provider data.</p>';
    const network = sample.network;
    result += '<h4>' + icon('network') + 'Network counters</h4>' + table(row('Total received', resourceBytes(network?.receivedBytes)) + row('Total sent', resourceBytes(network?.sentBytes)));
    const interfaces = Array.isArray(network?.interfaces) ? network.interfaces : [];
    for (const entry of interfaces) {
      result += '<div class="resource-interface"><strong>' + safe(entry.name || 'Interface') + '</strong>' + table(row('Received / sent', resourceBytes(entry.receivedBytes) + ' / ' + resourceBytes(entry.sentBytes)) + row('Receive / send errors', (number(entry.receiveErrors) ? entry.receiveErrors : '—') + ' / ' + (number(entry.sendErrors) ? entry.sendErrors : '—'))) + '</div>';
    }
    if (!interfaces.length) result += '<p class="resource-detail-note">Interface details unavailable.</p>';
    result += '<p class="resource-detail-note">Counter scope: ' + safe(network?.counterScope || 'unavailable') + '. Rates are measured between host observations; counters are not monthly billed traffic.</p>';
    if (number(sample.sampledAtMs)) result += '<p class="resource-detail-note">Host sample timestamp: ' + safe(new Date(sample.sampledAtMs).toISOString()) + '</p>';
    return result;
  }
  const providerNumber = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—';
  const providerTime = value => value !== null && value !== undefined && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '—';
  const providerList = value => Array.isArray(value) ? value : [];
  function providerHosts() {
    const provider = snapshot?.resources?.providerUsage;
    return resourceHostDefinitions.map(definition => providerList(provider?.hosts).find(host => host.id === definition.id) || { ...definition, status: provider ? 'unavailable' : 'loading', checkedAt: null, snapshot: null });
  }
  function createProviderCards() {
    $('providerHosts').innerHTML = resourceHostDefinitions.map(host => {
      const id = 'provider-' + host.id + '-';
      return '<article class="host-card provider-card" aria-labelledby="' + id + 'title"><div class="host-head"><span class="host-symbol provider-symbol" aria-hidden="true">' + icon('cloud') + '</span><div class="host-title"><h3 id="' + id + 'title">' + host.label + ' account</h3><p id="' + id + 'region" class="host-role">Oracle Cloud · separate tenancy</p></div><span id="' + id + 'status" class="badge">Connecting</span></div><div class="provider-summary"><div><span class="provider-summary-label">Managed database</span><strong id="' + id + 'database" class="provider-summary-value">Awaiting provider</strong></div><div><span class="provider-summary-label">Reported consumption</span><strong id="' + id + 'usage" class="provider-summary-value">Awaiting provider</strong></div></div><div class="provider-balance"><span>Free-tier allowance remaining</span><strong id="' + id + 'free">Unavailable</strong></div><div class="host-observation"><span id="' + id + 'sampled">No provider snapshot yet</span><span id="' + id + 'age">Waiting for sample</span></div><p id="' + id + 'error" class="host-error" hidden></p><details class="host-details"><summary>Database, usage &amp; service quotas</summary><div id="' + id + 'details" class="resource-details-body"><p class="resource-detail-note">Waiting for provider data.</p></div></details></article>';
    }).join('');
  }
  function providerStatus(host) {
    if (host.status === 'loading') return 'Collecting';
    if (host.status !== 'available' || !host.snapshot) return 'Unavailable';
    const sections = ['compute', 'database', 'usage', 'limits'].map(key => host.snapshot[key]?.status);
    if (sections.every(status => status === 'available')) return 'Observed';
    if (sections.some(status => status === 'available' || status === 'partial')) return 'Partial access';
    return 'Data unavailable';
  }
  function tickProviders() {
    const interval = number(snapshot?.resources?.providerUsage?.sampleIntervalMs) ? snapshot.resources.providerUsage.sampleIntervalMs : 300000;
    for (const host of providerHosts()) {
      const node = providerElement(host.id, 'age');
      if (!node) continue;
      const age = resourceAge(host), stale = !connected || (age !== null && age > Math.max(interval * 3, 60000));
      node.textContent = age === null ? 'Waiting for sample' : (stale ? 'Stale · ' : '') + duration(age) + ' ago';
      node.className = stale ? 'stale' : '';
      const status = host.snapshot && stale ? 'Stale' : providerStatus(host);
      pill(providerElement(host.id, 'status'), status === 'Observed' ? 'green' : status === 'Collecting' ? '' : 'orange', status);
    }
  }
  function providerUnavailable(section, fallback = 'Provider data is unavailable.') {
    const error = section?.error;
    const code = [number(error?.httpStatus) ? 'HTTP ' + error.httpStatus : '', error?.code].filter(Boolean).join(' · ');
    return '<p class="provider-unavailable">' + safe(section?.reason || fallback) + (code ? ' <span class="mono">(' + safe(code) + ')</span>' : '') + '</p>';
  }
  function providerDetails(host) {
    const sample = host.snapshot;
    if (!sample) return '<p class="resource-detail-note">' + (host.status === 'loading' ? 'Collecting provider inventory and usage. This can take longer than host sampling.' : 'Provider data is unavailable. Host measurements above remain independent.') + '</p>';
    const row = (label, value) => '<tr><th scope="row">' + safe(label) + '</th><td>' + safe(value) + '</td></tr>';
    const table = rows => '<table class="resource-table"><tbody>' + rows + '</tbody></table>';
    const available = section => section?.status === 'available' || section?.status === 'partial';
    const section = (key, title, data, content) => '<details class="provider-section" data-provider-section="' + key + '"><summary>' + icon({ database: 'database', usage: 'usage', limits: 'quota', compute: 'server' }[key]) + title + '<span class="badge' + (data?.status === 'available' ? ' green' : ' orange') + '">' + (data?.status === 'available' ? 'Available' : data?.status === 'partial' ? 'Partial' : 'Unavailable') + '</span></summary><div class="provider-section-content">' + content + (data?.truncated ? '<p class="provider-unavailable">The provider returned a partial list. Additional records are not shown.</p>' : '') + '</div></details>';
    const scope = data => '<p class="provider-scope">' + safe([data?.region, data?.scope].filter(Boolean).join(' · ')) + '</p>';
    const metricNames = { CpuUtilization: 'CPU utilization', SgaUtilization: 'SGA utilization', PgaUtilization: 'PGA utilization', SessionUtilization: 'Session utilization', StorageUsed: 'Storage used', StorageMax: 'Storage maximum', SQLNetBytesFromClient: 'Client → database', SQLNetBytesToClient: 'Database → client' };
    const database = sample.database;
    let databaseHtml = available(database) ? scope(database) : providerUnavailable(database, 'Managed database inventory and metrics require provider access. No local database process does not mean a managed database is absent.');
    const databases = providerList(database?.items);
    if (available(database) && !databases.length) databaseHtml += '<p class="provider-empty">No Autonomous Databases were returned in this account’s queried compartment and region. This is not an inventory of other accounts or compartments.</p>';
    for (const item of databases) {
      const tier = item.isFreeTier === true ? 'Provider marks this database as free tier' : item.isFreeTier === false ? 'Not marked free tier by provider' : 'Free-tier resource label unavailable';
      databaseHtml += '<article class="provider-item"><h4 class="provider-item-title">' + safe(item.name || 'Oracle Autonomous Database') + '</h4><p class="provider-item-meta">Oracle Autonomous Database · ' + safe(item.state || 'State unavailable') + '<br>' + safe(tier) + '</p>' + table(row('Compute model / count', (item.computeModel || '—') + ' / ' + providerNumber(item.computeCount)) + row('OCPUs / provisioned storage', providerNumber(item.ocpus) + ' / ' + (number(item.storageGB) ? providerNumber(item.storageGB) + ' GB' : '—'))) + '<div class="provider-metric-grid">';
      for (const [key, label] of Object.entries(metricNames)) {
        const metric = item.metrics?.[key];
        const measured = metric?.status === 'available' && typeof metric.value === 'number' && Number.isFinite(metric.value);
        const unit = metric?.unit === 'percent' ? '%' : metric?.unit || 'unit unavailable';
        const value = measured ? providerNumber(metric.value) + (unit === '%' ? '' : ' ') + unit : 'Unavailable';
        const aggregation = key.startsWith('SQLNet') ? 'window total' : key.startsWith('Storage') ? 'window maximum' : 'window mean';
        databaseHtml += '<div class="provider-metric"><span class="provider-metric-label">' + icon(key.startsWith('SQLNet') ? key.endsWith('FromClient') ? 'ingress' : 'egress' : key.startsWith('Storage') ? 'disk' : key === 'CpuUtilization' ? 'cpu' : key === 'SessionUtilization' ? 'activity' : 'memory') + safe(label) + '</span><strong>' + safe(value) + '</strong>' + (measured ? '<small>' + safe(number(metric.intervalSeconds) ? duration(metric.intervalSeconds * 1000) + ' ' + aggregation : 'Window unavailable') + '</small><small>At ' + safe(providerTime(metric.dataAt)) + '</small>' : '<small>' + safe(metric?.reason || 'No provider datapoint') + '</small>') + '</div>';
      }
      databaseHtml += '</div></article>';
    }
    if (databases.length) databaseHtml += '<p class="resource-detail-note">Latest provider datapoints from the collection window; each has its own time and interval. Database traffic is a window total in bytes, not a per-second rate. A free-tier resource label does not state an account’s remaining allowance.</p>';
    const usage = sample.usage;
    let usageHtml = '<p class="resource-detail-note">Provider-reported consumption for this tenancy. Quantities are usage records, not currency charges or a remaining free-tier balance.</p>';
    if (usage?.periodStart || usage?.periodEndExclusive) usageHtml += table(row('Period starts · UTC', providerTime(usage.periodStart)) + row('Period ends · exclusive', providerTime(usage.periodEndExclusive)));
    usageHtml += '<p class="resource-detail-note">' + (usage?.excludesCurrentDay ? 'The current UTC day is excluded. ' : '') + 'Provider billing records can arrive late; this is not live traffic.</p>';
    if (!available(usage)) usageHtml += providerUnavailable(usage, 'Provider consumption records require additional access.');
    else {
      const rows = providerList(usage.rows);
      usageHtml += scope(usage);
      usageHtml += rows.length ? '<div class="provider-table-wrap" tabindex="0" aria-label="Provider consumption records"><table class="resource-table provider-usage-table"><tbody>' + rows.map(entry => '<tr><th scope="row"><strong>' + safe(entry.service || 'Service unavailable') + '</strong><small>' + safe(entry.skuName || entry.skuPartNumber || 'SKU unavailable') + (entry.skuName && entry.skuPartNumber ? ' · ' + safe(entry.skuPartNumber) : '') + '</small><small>' + safe(entry.region || 'Region unavailable') + '</small></th><td>' + safe(providerNumber(entry.quantity)) + '<small>' + safe(entry.unit || 'Unit unavailable') + '</small><small>' + safe(providerTime(entry.dataStart)) + '<br>→ ' + safe(providerTime(entry.dataEnd)) + '</small></td></tr>').join('') + '</tbody></table></div>' : '<p class="provider-empty">No consumption rows were returned for this period. This does not establish zero usage or free-tier eligibility.</p>';
    }
    const limits = sample.limits;
    let limitsHtml = '<p class="resource-detail-note">Provisioning quotas control what this account can allocate. They are not free-tier entitlements or a billing balance.</p>';
    if (!available(limits)) limitsHtml += providerUnavailable(limits, 'Service quota data requires provider access.');
    else {
      limitsHtml += scope(limits);
      const items = providerList(limits.items);
      if (!items.length) limitsHtml += '<p class="provider-empty">No matching service quota records were returned.</p>';
      for (const item of items) {
        const capacity = item.availability;
        limitsHtml += '<article class="provider-item"><h4 class="provider-item-title mono">' + safe(item.name || 'Compute quota') + '</h4><p class="provider-item-meta">' + safe([item.scopeType, item.availabilityDomain].filter(Boolean).join(' · ') || 'Scope unavailable') + '</p>' + table(row('Provider limit', providerNumber(item.limit)));
        limitsHtml += available(capacity) ? table(row('Used / available', providerNumber(capacity.used) + ' / ' + providerNumber(capacity.available)) + row('Effective quota', providerNumber(capacity.effectiveQuota)) + row('Fractional usage / availability', providerNumber(capacity.fractionalUsage) + ' / ' + providerNumber(capacity.fractionalAvailability))) : providerUnavailable(capacity, 'Quota availability is unavailable.');
        limitsHtml += '</article>';
      }
    }
    const compute = sample.compute;
    let computeHtml = available(compute) ? scope(compute) : providerUnavailable(compute, 'Cloud compute inventory requires provider access.');
    const instances = providerList(compute?.items);
    if (available(compute) && !instances.length) computeHtml += '<p class="provider-empty">No compute instances were returned in the queried compartment.</p>';
    for (const item of instances) computeHtml += '<article class="provider-item"><h4 class="provider-item-title">' + safe(item.name || 'Compute instance') + '</h4>' + table(row('Lifecycle state', item.state || '—') + row('Shape', item.shape || '—') + row('OCPUs / provisioned RAM', providerNumber(item.ocpus) + ' / ' + (number(item.memoryGB) ? providerNumber(item.memoryGB) + ' GB' : '—')) + row('Provisioned network bandwidth', number(item.networkBandwidthGbps) ? providerNumber(item.networkBandwidthGbps) + ' Gbit/s' : '—')) + '</article>';
    let html = section('database', 'Autonomous Database', database, databaseHtml) + section('usage', 'Consumption records', usage, usageHtml) + section('limits', 'Service quotas', limits, limitsHtml) + section('compute', 'Compute inventory', compute, computeHtml);
    html += '<p class="provider-free-note"><strong>Free-tier balance unavailable</strong>' + safe(sample.freeTier?.reason || 'No exact free-tier entitlement or remaining allowance was supplied by the provider. Usage and service quotas cannot establish this balance.') + '</p>';
    html += '<p class="resource-detail-note">Collected ' + safe(providerTime(sample.sampledAtMs)) + '. This account is reported separately; allowances and consumption are not combined with the other tenancy.</p>';
    return html;
  }
  function renderProviders(provider) {
    const interval = number(provider?.sampleIntervalMs) ? provider.sampleIntervalMs : 300000;
    $('providerRefresh').textContent = interval >= 60000 ? Math.round(interval / 60000) + 'min provider sampling' : Math.round(interval / 1000) + 's provider sampling';
    for (const host of providerHosts()) {
      const id = host.id, sample = host.snapshot, database = sample?.database, usage = sample?.usage;
      providerElement(id, 'title').textContent = (host.label || resourceHostDefinitions.find(item => item.id === id).label) + ' account';
      providerElement(id, 'region').textContent = 'Oracle Cloud · ' + (sample?.region || 'separate tenancy');
      const databaseCount = providerList(database?.items).length;
      const databaseAvailable = database?.status === 'available' || database?.status === 'partial';
      const metricCount = providerList(database?.items).reduce((sum, item) => sum + Object.values(item.metrics || {}).filter(metric => metric?.status === 'available').length, 0);
      providerElement(id, 'database').textContent = databaseAvailable ? databaseCount ? databaseCount + ' database' + (databaseCount === 1 ? '' : 's') + ' · ' + metricCount + ' metrics' : 'None in queried scope' : host.status === 'loading' ? 'Awaiting provider' : 'Access unavailable';
      providerElement(id, 'usage').textContent = usage?.status === 'available' ? providerList(usage.rows).length + ' consumption records' : host.status === 'loading' ? 'Awaiting provider' : 'Access unavailable';
      providerElement(id, 'sampled').textContent = host.checkedAt ? 'Provider checked ' + sampleClock(host.checkedAt) : 'No provider snapshot yet';
      const error = providerElement(id, 'error');
      error.hidden = !host.error;
      error.textContent = host.error ? String(host.error) + (sample ? ' Displaying the last provider snapshot.' : '') : '';
      const key = JSON.stringify({ status: host.status, snapshot: sample });
      if (providerDetailKeys.get(id) !== key) {
        const body = providerElement(id, 'details');
        const expanded = new Set(Array.from(body.querySelectorAll('details[open][data-provider-section]'), element => element.dataset.providerSection));
        body.innerHTML = providerDetails(host);
        for (const detail of body.querySelectorAll('details[data-provider-section]')) detail.open = expanded.has(detail.dataset.providerSection);
        providerDetailKeys.set(id, key);
      }
    }
  }
  function renderResources(resources) {
    const interval = number(resources?.sampleIntervalMs) ? resources.sampleIntervalMs : 10000;
    $('resourceRefresh').textContent = Math.round(interval / 1000) + 's host sampling';
    renderProviders(resources?.providerUsage);
    for (const host of resourceHosts()) {
      const id = host.id, sample = host.snapshot;
      hostElement(id, 'title').textContent = host.label || resourceHostDefinitions.find(item => item.id === id).label;
      hostElement(id, 'role').textContent = host.role || resourceHostDefinitions.find(item => item.id === id).role;
      const cpu = number(sample?.cpu?.usagePercent) ? sample.cpu.usagePercent : null;
      const cores = sample?.cpu?.logicalCores;
      hostValue(id, 'cpu', percent(cpu) || (sample && host.status === 'available' ? 'Measuring' : '—'));
      hostElement(id, 'cpuCapacity').textContent = (cpu === null ? 'Availability —' : percent(Math.max(0, 100 - cpu)) + ' available') + '\n' + (number(cores) ? cores + ' logical core' + (cores === 1 ? '' : 's') : 'Core count unavailable');
      const memory = sample?.memory;
      hostValue(id, 'memory', resourceBytes(memory?.availableBytes));
      hostElement(id, 'memoryCapacity').textContent = resourceBytes(memory?.usedBytes) + ' used\n' + resourceBytes(memory?.totalBytes) + ' total';
      const disks = Array.isArray(sample?.disks) ? sample.disks : [];
      const disk = disks.find(item => item.path === '/');
      hostValue(id, 'disk', resourceBytes(disk?.availableBytes));
      hostElement(id, 'diskCapacity').textContent = resourceBytes(disk?.usedBytes) + ' used\n' + resourceBytes(disk?.totalBytes) + ' total · /';
      hostElement(id, 'diskCapacity').title = 'Root filesystem (/)';
      capacityTrack(id, 'cpuTrack', cpu);
      capacityTrack(id, 'memoryTrack', proportion(memory?.usedBytes, memory?.totalBytes));
      capacityTrack(id, 'diskTrack', proportion(disk?.usedBytes, disk?.totalBytes));
      const network = sample?.network;
      const waitingRate = sample && host.status === 'available' && network ? 'Measuring' : '—';
      hostElement(id, 'ingress').textContent = rate(network?.ingressBytesPerSecond) || waitingRate;
      hostElement(id, 'egress').textContent = rate(network?.egressBytesPerSecond) || waitingRate;
      hostElement(id, 'sampled').textContent = host.checkedAt ? (sample ? 'Observed ' : 'Checked ') + sampleClock(host.checkedAt) : 'No observation yet';
      const error = hostElement(id, 'error');
      error.hidden = !host.error;
      error.textContent = host.error ? String(host.error) + (sample ? ' Displaying the last host snapshot.' : '') : '';
      const detailKey = JSON.stringify({ status: host.status, snapshot: sample });
      if (resourceDetailKeys.get(id) !== detailKey) {
        hostElement(id, 'details').innerHTML = resourceDetails(host);
        resourceDetailKeys.set(id, detailKey);
      }
    }
    tickResources();
  }

  function render(data) {
    snapshot = data; receivedAt = performance.now(); connection(true);
    const release = data.release || {}, monitor = data.monitor || {}, prod = data.production || {}, steps = release.steps || [], running = release.status === 'running';
    const releaseLevel = running ? 'green' : release.status === 'succeeded' ? 'green' : ['failed', 'interrupted'].includes(release.status) ? 'red' : '';
    const releaseStatus = release.kind === 'rollback' ? { running: 'Rollback in progress', succeeded: 'Rollback successful', failed: 'Rollback failed', interrupted: 'Rollback interrupted' }[release.status] : null;
    pill($('releaseState'), releaseLevel, releaseStatus || statusNames[release.status] || 'Status unavailable');
    updateActions();
    $('runLabel').textContent = release.runId ? (release.kind === 'rollback' ? 'ROLLBACK #' : 'RELEASE #') + release.runId : 'READY WHEN YOU ARE';
    $('releaseStarted').textContent = release.startedAt ? (running ? 'Started ' : 'Last run ') + date(release.startedAt) : 'Build, verify, and publish to production';
    $('totalTimeNote').textContent = running ? 'Since this release started' : release.finishedAt ? 'Finished ' + date(release.finishedAt) : 'From start to production verification';
    const active = steps.find(step => step.status === 'running');
    $('activeStep').textContent = active ? active.label : release.status === 'succeeded' ? release.kind === 'rollback' ? 'Previous release restored' : 'Release complete' : release.status === 'failed' ? 'Needs attention' : release.status === 'interrupted' ? 'Release interrupted' : 'Ready to begin';
    $('pipelineSubtitle').textContent = running ? release.kind === 'rollback' ? 'Restoring the previous release and verifying production health' : 'Following each stage from source to production' : release.runId ? (release.kind === 'rollback' ? 'Rollback #' : 'Release #') + release.runId + ' · ' + (release.finishedAt ? 'Finished ' + date(release.finishedAt) : 'Started ' + date(release.startedAt)) : 'Every stage, measured from start to finish';
    renderSteps(steps); memoryChart(release.metrics);
    const version = prod.version;
    $('version').textContent = typeof version === 'string' ? version : version?.displayVersion || version?.version || '—';
    $('deployed').textContent = date(prod.builtAt);
    $('commit').textContent = prod.commitHash && prod.commitHash !== 'unknown' ? prod.commitHash.slice(0, 12) : 'Unavailable';
    $('commit').href = safeUrl(prod.gitLink);
    $('commit').title = prod.commitHash || 'Commit unavailable';
    $('commitMessage').textContent = prod.commitMessage || 'No source commit metadata available.';
    $('commitMessage').title = prod.commitDate ? 'Committed ' + date(prod.commitDate) : '';
    const url = safeUrl(prod.url);
    $('productionLink').href = url; $('headerProduction').href = url;
    $('productionHost').textContent = url === '#' ? 'Production unavailable' : new URL(url).host;
    const monitorLabel = monitor.level === 'green' ? 'Healthy' : monitor.level === 'orange' ? 'Degraded' : monitor.level === 'red' ? 'Unavailable' : 'Waiting';
    pill($('productionStatus'), monitor.level, monitorLabel);
    pill($('monitorState'), monitor.level, monitorLabel);
    $('monitorSummary').textContent = monitor.summary || 'Waiting for the first production check.';
    $('checks').innerHTML = (monitor.checks || []).map(check => '<div class="check ' + (check.ok ? 'ok' : 'bad') + '"><span class="check-name"><span class="check-dot" aria-hidden="true"></span>' + safe(check.path) + '</span><span class="check-result">' + (check.ok ? '✓ ' : '✕ ') + safe(check.status || 'offline') + ' · ' + (number(check.latencyMs) ? Math.round(check.latencyMs) + 'ms' : '—') + '</span></div>').join('') || '<p class="empty">Waiting for the first check…</p>';
    $('monitorTime').textContent = monitor.checkedAt ? 'Last checked ' + date(monitor.checkedAt) + ' · hourly' : 'Checks run every hour';
    const notifications = data.notifications || {};
    pill($('mailStatus'), notifications.configured ? 'green' : 'orange', notifications.configured ? 'Connected' : 'Not configured');
    $('mailNote').textContent = notifications.configured ? (notifications.provider || 'Email') + ' delivers release results and production incident alerts.' : 'Email delivery is not configured on this host.';
    $('admins').innerHTML = (data.admins || []).map(email => '<li><span class="admin-dot" aria-hidden="true">@</span>' + safe(email) + '</li>').join('') || '<li>No recipients configured.</li>';
    const log = String(release.log || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (lastLog !== log) {
      lastLog = log; $('log').textContent = log || 'Ready. Start a release to follow the build output here.';
      if ($('autoscroll').checked) $('log').scrollTop = $('log').scrollHeight;
    }
    $('downloadLog').disabled = !log;
    renderResources(data.resources);
    tick();
  }
  async function refresh() {
    if (fetching || sessionExpired) return;
    fetching = true;
    try {
      const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (response.status === 401) { expireSession(); return; }
      if (!response.ok) throw new Error('Status request returned ' + response.status);
      const data = await response.json();
      if (!data.release || !Array.isArray(data.release.steps)) throw new Error('Status response is incomplete');
      render(data);
    } catch {
      connection(false);
      banner('The console cannot reach Hyderabad. Displayed values are the last confirmed snapshot; reconnecting automatically.');
      tick();
    } finally { fetching = false; }
  }
  async function requestRelease(kind) {
    const rollback = kind === 'rollback', action = rollback ? 'rollback' : 'release';
    if ($(rollback ? 'rollback' : 'release').disabled || actionPending) return;
    const version = rollbackVersion();
    const confirmation = rollback ? 'Restore the previous release' + (version ? ' (' + version + ')' : '') + '? This restores the saved fallback on Mumbai, restarts the production service, and checks production health.' : 'Build the latest source on Hyderabad and deploy it to Mumbai production? This starts the full release and restarts the production service after validation.';
    if (!window.confirm(confirmation)) return;
    actionPending = true; actionKind = kind; actionMessage = ''; updateActions(); banner('');
    try {
      const response = await fetch(rollback ? '/api/rollback' : '/api/build', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: '{}' });
      if (response.status === 401) { expireSession(); return; }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.release) render(data);
        throw new Error(typeof data.error === 'string' ? data.error : 'The ' + action + ' request failed (' + response.status + ').');
      }
      if (data.release) render(data);
      else await refresh();
    } catch (error) {
      actionMessage = error.name === 'TimeoutError' || error.name === 'TypeError' ? 'The ' + action + ' request could not be confirmed. Checking its status; review the pipeline before trying again.' : error.message;
      banner(actionMessage);
      await refresh();
    } finally {
      actionPending = false; actionKind = null;
      updateActions();
    }
  }
  $('release').addEventListener('click', () => void requestRelease('build'));
  $('rollback').addEventListener('click', () => void requestRelease('rollback'));
  $('autoscroll').addEventListener('change', () => { if ($('autoscroll').checked) $('log').scrollTop = $('log').scrollHeight; });
  $('downloadLog').addEventListener('click', () => {
    if (!lastLog) return;
    if (logDownloadUrl) URL.revokeObjectURL(logDownloadUrl);
    logDownloadUrl = URL.createObjectURL(new Blob([lastLog], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = logDownloadUrl; link.download = 'chessalive-release-' + (snapshot?.release?.runId || 'latest') + '.log'; link.click();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  $('elapsedIcon').innerHTML = icon('clock');
  $('memoryIcon').innerHTML = icon('memory');
  $('stageIcon').innerHTML = icon('activity');
  createResourceCards();
  createProviderCards();
  void refresh();
  setInterval(() => void refresh(), 2000);
  setInterval(tick, 250);
}

function loginClient() {
  const form = document.getElementById('login'), password = document.getElementById('password'), button = document.getElementById('submit'), error = document.getElementById('error');
  form.addEventListener('submit', async event => {
    event.preventDefault(); button.disabled = true; error.textContent = ''; document.getElementById('submitLabel').textContent = 'Opening console…';
    try {
      const response = await fetch('/api/login', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: password.value }) });
      if (!response.ok) throw new Error(response.status === 401 ? 'That password is incorrect. Please try again.' : 'Sign-in is unavailable. Please try again shortly.');
      location.reload();
    } catch (reason) {
      error.textContent = reason.name === 'TypeError' || reason.name === 'TimeoutError' ? 'Unable to reach the console. Check your connection and try again.' : reason.message;
      password.focus(); password.select(); button.disabled = false; document.getElementById('submitLabel').textContent = 'Open release console';
    }
  });
}

const head = title => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#152c37"><title>' + title + '</title><link rel="icon" type="image/png" href="/branding/favicon.png?v=8"><style>' + styles + '</style></head>';

export const loginHtml = head('Sign in · ChessAlive Operations') + String.raw`
<body class="login-page"><main class="login-shell"><div class="brand login-brand"><img class="brand-mark" src="/branding/chessalive-logo.png?v=8" width="38" height="38" alt="">ChessAlive</div><section class="login-card"><div class="login-route"><span class="dot" aria-hidden="true"></span>Hyderabad <span aria-hidden="true">→</span> Mumbai</div><h1>Your release command center.</h1><p class="login-copy">Build with clarity. Ship with confidence.<br>Sign in for release controls, live build metrics, and production health.</p><form id="login"><label for="password">Console password</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required placeholder="Enter your console password"><button class="primary" id="submit" type="submit"><span id="submitLabel">Open release console</span><span class="arrow" aria-hidden="true">→</span></button><p id="error" class="login-error" role="alert"></p></form></section><p class="login-foot">ChessAlive Operations · Authorized access only<br>Your session is securely managed by the build host.</p></main><script>(` + loginClient.toString() + ')();</script></body></html>';

export const dashboardHtml = head('Release center · ChessAlive Operations') + String.raw`
<body><header class="topbar"><div class="topbar-inner"><a class="brand" href="/" aria-label="ChessAlive release console"><img class="brand-mark" src="/branding/chessalive-logo.png?v=8" width="38" height="38" alt="">ChessAlive<span class="brand-sub">OPERATIONS</span></a><span class="nav-current">Release center</span><div class="top-right"><a id="headerProduction" class="link" href="#" target="_blank" rel="noopener noreferrer">Open production<span aria-hidden="true">↗</span></a><span class="avatar" title="Operations console" aria-hidden="true">OP</span></div></div></header>
<main class="shell"><div class="page-heading"><div><p class="breadcrumb">Operations <span>/</span> Release center</p><h1>Release command center</h1><p class="page-subtitle">A clear view of every build, from source to production.</p></div><div id="connection" class="connection" role="status"><span class="dot" aria-hidden="true"></span><span id="connectionLabel">Connecting to Hyderabad</span></div></div>
<section class="hero" aria-label="Release controls"><div><p class="hero-kicker"><span class="dot" aria-hidden="true"></span>CHESSALIVE RELEASE PIPELINE</p><div class="route"><div class="route-city">Hyderabad<span class="route-label">Build &amp; validation</span></div><div class="route-arrow" aria-hidden="true"></div><div class="route-city">Mumbai<span class="route-label">Production deployment</span></div></div><p class="hero-copy">Latest source. Verified artifacts. Atomic deployment.</p></div><div class="hero-action"><p id="runLabel" class="run-label mono">READY WHEN YOU ARE</p><div class="release-actions"><button id="release" class="primary" disabled><span id="releaseLabel">Build &amp; deploy</span><span class="arrow" aria-hidden="true">↗</span></button><button id="rollback" class="secondary" title="Restore previous release" aria-describedby="rollbackNote" disabled><span id="rollbackLabel">Roll back</span><span aria-hidden="true">↶</span></button></div><p id="releaseStarted" class="hero-action-note">Build, verify, and publish to production</p><p id="rollbackNote" class="rollback-note">Checking for a previous release</p></div></section>
<div id="notice" class="notice" role="alert" hidden></div>
<section class="metrics" aria-label="Release metrics"><div class="metric"><div class="metric-label">Total elapsed<span id="elapsedIcon" class="metric-icon" aria-hidden="true"></span></div><p id="totalTime" class="metric-value mono">0s</p><p id="totalTimeNote" class="metric-note">From start to production verification</p></div><div class="metric"><div class="metric-label">Peak build memory<span id="memoryIcon" class="metric-icon" aria-hidden="true"></span></div><p id="peakMemory" class="metric-value mono">—</p><p id="peakMemoryNote" class="metric-note">Measured during the next build</p></div><div class="metric"><div class="metric-label">Current stage<span id="stageIcon" class="metric-icon" aria-hidden="true"></span></div><p id="activeStep" class="metric-value metric-active">Ready to begin</p><p id="activeTime" class="metric-note">Waiting for the next release</p></div></section>
<section class="infrastructure" aria-labelledby="infrastructureTitle"><div class="infrastructure-heading"><div><h2 id="infrastructureTitle">Infrastructure</h2><p>Observed host usage and available capacity, across both regions.</p></div><span id="resourceRefresh" class="resource-refresh">10s sampling</span></div><div id="resourceHosts" class="resource-hosts"></div><p class="resource-thresholds"><span>Bars show observed usage</span><span><i aria-hidden="true"></i>High ≥85%</span><span class="critical"><i aria-hidden="true"></i>Attention ≥95%</span></p><div class="infrastructure-heading provider-heading"><div><h3>Cloud accounts &amp; managed database</h3><p>Two separate Oracle Cloud accounts. Provider consumption, quotas, and free-tier eligibility are distinct.</p></div><span id="providerRefresh" class="resource-refresh">5min provider sampling</span></div><div id="providerHosts" class="resource-hosts"></div></section>
<div class="content-grid"><div class="main-column"><section class="card"><div class="card-header"><div><h2 class="card-title">Release pipeline</h2><p id="pipelineSubtitle" class="card-subtitle">Every stage, measured from start to finish</p></div><span id="releaseState" class="badge">Connecting</span></div><div class="pipeline-summary"><div class="pipeline-track" role="progressbar" aria-label="Pipeline stages complete" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><span id="pipelineProgress" style="width:0%"></span></div><span id="pipelineCount" class="pipeline-count mono">0 / 0 complete</span></div><div class="pipeline-columns" aria-hidden="true"><span>Build stage</span><span>Elapsed</span><span>Peak RSS</span></div><ol id="timeline" class="timeline"><li class="empty" style="padding:20px 23px">Connecting to the build host…</li></ol><div class="pipeline-foot">Bars compare each step with the longest step. Pending times and unavailable memory appear as —.</div></section>
<section class="card logs-card"><div class="card-header"><h2 class="card-title"><span class="terminal-icon" aria-hidden="true">&gt;_</span> Build output</h2><div class="log-actions"><label class="autoscroll"><input id="autoscroll" type="checkbox" checked>Auto-scroll</label><button id="downloadLog" class="small-button" disabled>Save log <span aria-hidden="true">↓</span></button></div></div><pre id="log" class="log" tabindex="0" aria-label="Recent release output">Ready. Start a release to follow the build output here.</pre><div class="logs-foot"><span id="logStatus">Output will appear when a release starts</span><span>Latest 14 KB</span></div></section></div>
<aside class="sidebar" aria-label="Build resources and production status"><section class="card memory-card"><div class="card-header"><h2 class="card-title">Memory profile</h2><span id="memoryStatus" class="card-subtitle" style="margin:0">No live sample</span></div><div class="memory-values"><strong id="currentMemory" class="memory-current mono">—</strong><span id="memoryLabel" class="memory-unit-note">current process RSS</span></div><div id="memoryChart" class="chart-box"><div class="chart-empty">Memory history appears during a build</div></div><div class="chart-scale"><span id="chartStart">—</span><span id="chartEnd">—</span></div><div class="memory-foot">Sampled resident memory across the build process tree. Overlapping steps share the same memory scope; shared pages may be counted more than once.</div></section>
<section class="card"><div class="card-header"><h2 class="card-title">Production</h2><span id="productionStatus" class="badge">Waiting</span></div><div class="side-body"><a id="productionLink" class="production-link" href="#" target="_blank" rel="noopener noreferrer"><span id="productionHost">chessalive.com</span><span aria-hidden="true">↗</span></a><dl class="metadata"><div class="metadata-row"><dt>Region</dt><dd>Mumbai</dd></div><div class="metadata-row"><dt>Live version</dt><dd id="version" class="mono">—</dd></div><div class="metadata-row"><dt>Built at</dt><dd id="deployed">—</dd></div><div class="metadata-row"><dt>Source commit</dt><dd><a id="commit" class="mono" href="#" target="_blank" rel="noopener noreferrer">—</a></dd></div></dl><p id="commitMessage" class="commit-message">Loading source commit metadata…</p></div></section>
<section class="card"><div class="card-header"><h2 class="card-title">Production health</h2><span id="monitorState" class="badge">Waiting</span></div><div class="side-body"><p id="monitorSummary" class="monitor-description">Waiting for the first production check.</p><div id="checks" class="checks"></div><div id="monitorTime" class="monitor-foot">Checks run every hour</div></div></section>
<section class="card notification-card"><div class="card-header"><h2 class="card-title">Notifications</h2><span id="mailStatus" class="badge">Waiting</span></div><div class="side-body"><p class="notification-copy">Release results and production incident alerts go to your operations team.</p><ul id="admins" class="admins"></ul><p id="mailNote" class="mail-note">Checking delivery configuration…</p></div></section></aside></div>
<footer class="footer"><span class="footer-brand">ChessAlive Operations <span aria-hidden="true">·</span> Hyderabad → Mumbai</span><span>Status refreshes every 2 seconds · Production checks run hourly</span></footer></main><script>(` + dashboardClient.toString() + ')();</script></body></html>';
