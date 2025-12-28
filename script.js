let ws = null;
const indices = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const prices = {};
let bbChart, macdChart, emaRsiChart;
let signalTimer;

// Initialize price arrays
indices.forEach(idx => prices[idx] = []);

// ===== CONNECT TO DERIV API =====
document.getElementById('connectBtn').addEventListener('click', () => {
    const token = document.getElementById('apiToken').value.trim();
    if (!token) return alert("Please enter your API token");

    ws = new WebSocket("wss://ws.binaryws.com/websockets/v3?app_id=1089");

    ws.onopen = () => {
        console.log("Connected to Deriv API");
        ws.send(JSON.stringify({ authorize: token }));
        indices.forEach(idx => ws.send(JSON.stringify({ ticks: idx, subscribe: 1 })));
        document.getElementById('scanBtn').disabled = false;
    };

    ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.tick && indices.includes(data.tick.symbol)) {
            updatePrices(data.tick.symbol, data.tick.quote);
        }
    };

    ws.onerror = (err) => console.error("WebSocket error:", err);
});

// ===== UPDATE PRICES =====
function updatePrices(symbol, latestPrice) {
    prices[symbol].push(latestPrice);
    if (prices[symbol].length > 50) prices[symbol].shift();
    updateCharts(symbol);
}

// ===== INDICATORS =====
function ema(arr, period) {
    let k = 2/(period+1), res = [arr[0]];
    for(let i=1;i<arr.length;i++) res.push(arr[i]*k + res[i-1]*(1-k));
    return res;
}

function rsi(prices, period=14){
    let gains=0, losses=0, res=[];
    for(let i=1;i<prices.length;i++){
        let change=prices[i]-prices[i-1];
        gains+=Math.max(0,change); losses+=Math.max(0,-change);
        if(i>=period){
            let avgG=gains/period, avgL=losses/period;
            res.push(100-(100/(1+avgG/avgL)));
            let oldChange=prices[i-period+1]-prices[i-period];
            gains-=Math.max(0,oldChange); losses-=Math.max(0,-oldChange);
        } else res.push(null);
    }
    res.unshift(null); return res;
}

function calcBollinger(prices, period=20, mult=2){
    let middle=[], upper=[], lower=[];
    for(let i=0;i<prices.length;i++){
        if(i<period-1){ middle.push(null); upper.push(null); lower.push(null); continue;}
        const slice=prices.slice(i-period+1,i+1);
        const mean=slice.reduce((a,b)=>a+b,0)/period;
        const std=Math.sqrt(slice.reduce((a,b)=>a+Math.pow(b-mean,2),0)/period);
        middle.push(mean); upper.push(mean+mult*std); lower.push(mean-mult*std);
    }
    return {middle, upper, lower};
}

// ===== UPDATE CHARTS =====
function updateCharts(symbol){
    const lastPrices = prices[symbol];
    if(lastPrices.length<2) return;

    const bb = calcBollinger(lastPrices);
    const ema50 = ema(lastPrices,50);
    const ema12 = ema(lastPrices,12);
    const ema26 = ema(lastPrices,26);
    const macdLine = ema12.map((v,i)=>v-(ema26[i]||0));
    const signalLine = ema(macdLine.filter(v=>v!==undefined),9);
    const rsi14 = rsi(lastPrices,14);

    if(symbol==="R_75"){ // main charts display
        // Bollinger Bands
        if(!bbChart){
            bbChart = new Chart(document.getElementById('bbChart').getContext('2d'),{
                type:'line',
                data:{labels:lastPrices.map((_,i)=>i+1),
                      datasets:[
                        {label:'Price',data:lastPrices,borderColor:'#ff0000',fill:false},
                        {label:'Middle',data:bb.middle,borderColor:'#00ff00',borderDash:[5,5],fill:false},
                        {label:'Upper',data:bb.upper,borderColor:'#ffffff',borderDash:[5,5],fill:false},
                        {label:'Lower',data:bb.lower,borderColor:'#ffffff',borderDash:[5,5],fill:false}
                      ]}
            });
        } else {
            bbChart.data.labels=lastPrices.map((_,i)=>i+1);
            bbChart.data.datasets[0].data=lastPrices;
            bbChart.data.datasets[1].data=bb.middle;
            bbChart.data.datasets[2].data=bb.upper;
            bbChart.data.datasets[3].data=bb.lower;
            bbChart.update();
        }

        // MACD
        if(!macdChart){
            macdChart = new Chart(document.getElementById('macdChart').getContext('2d'),{
                type:'line',
                data:{
                    labels:lastPrices.map((_,i)=>i+1),
                    datasets:[
                        {label:'MACD', data:macdLine, borderColor:'#ff0000', fill:false},
                        {label:'Signal', data:signalLine, borderColor:'#00ff00', fill:false}
                    ]
                }
            });
        } else {
            macdChart.data.labels=lastPrices.map((_,i)=>i+1);
            macdChart.data.datasets[0].data=macdLine;
            macdChart.data.datasets[1].data=signalLine;
            macdChart.update();
        }

        // EMA+RSI
        if(!emaRsiChart){
            emaRsiChart = new Chart(document.getElementById('emaRsiChart').getContext('2d'),{
                type:'line',
                data:{
                    labels:lastPrices.map((_,i)=>i+1),
                    datasets:[
                        {label:'Price',data:lastPrices,borderColor:'#ff0000',fill:false},
                        {label:'EMA50',data:ema50,borderColor:'#00ff00',fill:false},
                        {label:'RSI14',data:rsi14,borderColor:'#ffffff',fill:false,yAxisID:'rsi'}
                    ]
                },
                options:{scales:{y:{position:'left'}, rsi:{position:'right',min:0,max:100,grid:{display:false}}}}
            });
        } else {
            emaRsiChart.data.labels=lastPrices.map((_,i)=>i+1);
            emaRsiChart.data.datasets[0].data=lastPrices;
            emaRsiChart.data.datasets[1].data=ema50;
            emaRsiChart.data.datasets[2].data=rsi14;
            emaRsiChart.update();
        }
    }
}

// ===== SCAN STRONGEST SIGNAL WITH ENTRY/EXIT =====
document.getElementById('scanBtn').addEventListener('click',()=>{
    const timeframe=parseInt(document.getElementById('timeframe').value);
    const signals=[];

    indices.forEach(idx=>{
        if(prices[idx].length<20) return;
        const lastPrice=prices[idx][prices[idx].length-1];
        const bb=calcBollinger(prices[idx]);
        const ema50=ema(prices[idx],50);
        const ema12=ema(prices[idx],12);
        const ema26=ema(prices[idx],26);
        const macdLine=ema12.map((v,i)=>v-(ema26[i]||0));
        const signalLine=ema(macdLine.filter(v=>v!==undefined),9);
        const rsi14=rsi(prices[idx],14);

        const bbSig=lastPrice>bb.upper[bb.upper.length-1]?"FALL":
                    lastPrice<bb.lower[bb.lower.length-1]?"RISE":"--";

        const macdSig=macdLine[macdLine.length-1]>signalLine[signalLine.length-1]?"RISE":
                      macdLine[macdLine.length-1]<signalLine[signalLine.length-1]?"FALL":"--";

        const lastEMA=ema50[ema50.length-1];
        const lastRSI=rsi14[rsi14.length-1];
        const emaRsiSig=(lastPrice>lastEMA && lastRSI>50 && lastRSI<70)?"RISE":
                        (lastPrice<lastEMA && lastRSI<50 && lastRSI>30)?"FALL":"--";

        const arr=[bbSig,macdSig,emaRsiSig];
        const riseCount=arr.filter(s=>"RISE"===s).length;
        const fallCount=arr.filter(s=>"FALL"===s).length;
        const confidence=Math.abs(riseCount-fallCount);
        let finalSig=riseCount>fallCount?"RISE":fallCount>riseCount?"FALL":"NO CLEAR SIGNAL";

        // Projected Exit Price (basic volatility approximation)
        let projectedExit=finalSig==="RISE"?lastPrice*(1+0.002):finalSig==="FALL"?lastPrice*(1-0.002):lastPrice;

        signals.push({index:idx,signal:finalSig,confidence:confidence,entry:lastPrice,exit:projectedExit});
    });

    if(signals.length===0) return alert("Not enough data yet.");

    signals.sort((a,b)=>b.confidence-a.confidence);
    const strongest=signals[0];

    document.getElementById('signal-output').innerText=`Strongest Signal: ${strongest.signal} on ${strongest.index}`;
    document.getElementById('entry-exit').innerText=`Entry: ${strongest.entry.toFixed(3)} | Projected Exit: ${strongest.exit.toFixed(3)}`;

    let seconds=timeframe*60;
    const countdownEl=document.getElementById('countdown');
    countdownEl.innerText=`Signal valid for: ${seconds}s`;
    clearInterval(signalTimer);
    signalTimer=setInterval(()=>{
        seconds--;
        countdownEl.innerText=`Signal valid for: ${seconds}s`;
        if(seconds<=0){ clearInterval(signalTimer); countdownEl.innerText="Signal expired!";}
    },1000);
});