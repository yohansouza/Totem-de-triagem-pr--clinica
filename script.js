// =========================
// Navegação e progresso
// =========================
let currentScreen = 1;
const totalScreens = 17;

function updateProgress() {
  const progress = ((currentScreen - 1) / (totalScreens - 1)) * 100;
  const bar = document.getElementById('progress');
  if (bar) bar.style.width = progress + "%";
}

function showScreen(num) {
  const old = document.getElementById(`screen${currentScreen}`);
  const neu = document.getElementById(`screen${num}`);
  if (old) old.classList.remove('active');
  currentScreen = num;
  if (neu) neu.classList.add('active');
  updateProgress();
}

function nextScreen(screenNumber) {
  showScreen(screenNumber);
  MeasurementController.onScreenChange(screenNumber);
}

updateProgress();

// =========================
// Mapeamentos / UI
// =========================
const ScreenKeyMap = {
  5:  "PESO",
  6:  "ALTURA",
  8:  "HR",      // Tela 8: apenas frequência cardíaca
  9:  "SPO2",    // Tela 9: apenas saturação
  10: "TEMP",
  13: "GSR",
};

const KeySelectorMap = {
  "PESO":     "#pesoValue",
  "ALTURA":   "#alturaValue",
  "HR":       "#hrValue",
  "SPO2":     "#spo2Value",
  "TEMP":     "#tempValue",
  "GSR":      "#gsrValue"
};

const KeyRanges = {
  "HR":     [30, 220],
  "SPO2":   [70, 100],
  "TEMP":   [30, 43],
  "GSR":    [0, 1023],
  "ALTURA": [40, 250],
  "PESO":   [2, 300],
};

function clamp(n, min, max) { return Math.max(min, Math.min(n, max)); }

// =========================
// Medição com Web Serial
// =========================
const MeasurementController = (function(){
  let port, reader, serialConnected = false;
  let buffer = "";
  let measuringKey = null;
  let measuringActive = false;
  let lockOnFirstValid = true;
  let storedValues = {};
  let retryCount = 0;
  const MAX_RETRIES = 3;

  async function connectSerial() {
    try {
      if (!("serial" in navigator)) {
        setPortStatus("Seu navegador não suporta Web Serial. Use Chrome/Edge desktop.");
        return;
      }
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });

      const textDecoder = new TextDecoderStream();
      port.readable.pipeTo(textDecoder.writable);
      const inputStream = textDecoder.readable;
      reader = inputStream.getReader();

      serialConnected = true;
      setPortStatus("Conectado");
      readLoop();
    } catch (e) {
      console.error(e);
      setPortStatus("Falha na conexão: " + e.message);
    }
  }

  async function readLoop() {
    while (serialConnected && port && port.readable) {
      try {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          let lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          
          for (const lineRaw of lines) {
            const line = lineRaw.trim();
            if (line) {
              console.log("Recebido:", line);
              handleSensorLine(line);
            }
          }
        }
      } catch (e) {
        console.error("Erro na leitura serial:", e);
        setPortStatus("Erro de leitura");
        break;
      }
    }
  }

  function setPortStatus(txt) {
    const el = document.getElementById("portStatus");
    if (el) el.innerText = txt;
  }

  function setUIWaitingFor(key) {
    const sel = KeySelectorMap[key];
    if (sel) {
      document.querySelector(sel).innerText = "Aguardando…";
    }
    retryCount = 0;
  }

  function setUIValue(key, valText) {
    const sel = KeySelectorMap[key];
    if (sel) {
      document.querySelector(sel).innerText = valText;
    }
    storedValues[key] = valText;
  }

  function validByRange(key, val) {
    const r = KeyRanges[key];
    if (!r) return true;
    return val >= r[0] && val <= r[1];
  }

  function formatValue(key, val) {
    if (!Number.isFinite(val)) return "—";
    if (key === "HR")     return `${Math.round(val)} bpm`;
    if (key === "SPO2")   return `${val.toFixed(0)} %`;
    if (key === "TEMP")   return `${val.toFixed(1)} °C`;
    if (key === "GSR")    return `${Math.round(val)}`;
    if (key === "ALTURA") return `${val.toFixed(1)} cm`;
    if (key === "PESO")   return `${val.toFixed(1)} kg`;
    return String(val);
  }

  async function sendCommandRaw(s) {
    try {
      if (!port || !port.writable) {
        console.warn("Porta não disponível para escrita");
        return;
      }
      
      const data = new TextEncoder().encode(s + "\n");
      const w = port.writable.getWriter();
      await w.write(data);
      w.releaseLock();
      console.log("Comando enviado:", s);
    } catch (e) {
      console.warn("Falha ao enviar comando:", s, e);
      setPortStatus("Erro ao enviar comando");
    }
  }

  async function sendCommandForKey(key) {
    if (key === "HR" || key === "SPO2") return sendCommandRaw("HR_SPO2");
    if (key === "ALTURA") return sendCommandRaw("ALTURA");
    if (key === "TEMP")   return sendCommandRaw("TEMP");
    if (key === "GSR")    return sendCommandRaw("GSR");
  }

  function handleSensorLine(line) {
    if (line.includes(":")) {
      const parts = line.split(":");
      const key = parts[0].trim().toUpperCase();
      const valueStr = parts[1].trim();
      
      if (valueStr === "NA" || valueStr === "OUT") {
        if (measuringActive && measuringKey === key) {
          setUIValue(key, "Erro");
          retryCount++;
          if (retryCount < MAX_RETRIES && measuringActive) {
            setTimeout(() => sendCommandForKey(measuringKey), 1000);
          } else {
            measuringActive = false;
          }
        }
        return;
      }
      
      const val = parseFloat(valueStr);
      if (!isNaN(val)) {
        if (measuringActive && measuringKey === key) {
          if (validByRange(key, val)) {
            setUIValue(key, formatValue(key, clamp(val, KeyRanges[key][0], KeyRanges[key][1])));
            if (lockOnFirstValid) {
              measuringActive = false;
            }
          }
        }
      }
    }
  }

  function onScreenChange(screenNumber) {
    const key = ScreenKeyMap[screenNumber];
    measuringKey = key;
    
    if (!key) { 
      measuringActive = false; 
      return; 
    }

    // Se for SPO2 e já tivermos o valor armazenado do HR_SPO2, usar ele
    if (key === "SPO2" && storedValues["SPO2"]) {
      setUIValue("SPO2", storedValues["SPO2"]);
      measuringActive = false;
      return;
    }

    setUIWaitingFor(key);
    measuringActive = true;

    setTimeout(() => {
      sendCommandForKey(key);
    }, 300);
  }

  function setLockOnFirstValid(flag) { lockOnFirstValid = !!flag; }

  return { 
    connectSerial, 
    onScreenChange, 
    setLockOnFirstValid,
    isConnected: () => serialConnected
  };
})();

// Botão "Conectar Arduino"
document.getElementById("btnConnect").addEventListener("click", () => {
  MeasurementController.connectSerial();
});

// Eventos de (des)conexão do navegador
if (navigator.serial) {
  navigator.serial.addEventListener("connect", () => {
    const el = document.getElementById("portStatus");
    if (el) el.innerText = "Porta disponível – clique para conectar";
  });
  
  navigator.serial.addEventListener("disconnect", () => {
    const el = document.getElementById("portStatus");
    if (el) el.innerText = "Desconectado";
  });
}