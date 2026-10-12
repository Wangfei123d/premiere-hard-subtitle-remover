(function (root) {
  'use strict';
  var fs = require('fs');
  var os = require('os');
  var path = require('path');
  var child = require('child_process');
  var dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Codex', 'HardSubtitleRemover');
  var file = path.join(dir, 'api-key.dpapi');

  function powershell(script, value) {
    return new Promise(function (resolve, reject) {
      var encoded = Buffer.from(script, 'utf16le').toString('base64');
      var proc = child.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      var out = '', err = '';
      proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', function (chunk) { out += chunk; });
      proc.stderr.on('data', function (chunk) { err += chunk; });
      proc.on('error', reject);
      proc.on('close', function (code) {
        if (code !== 0) return reject(new Error((err || 'Windows DPAPI 操作失败。').trim()));
        resolve(out.trim());
      });
      proc.stdin.end(Buffer.from(String(value || ''), 'utf8').toString('base64'));
    });
  }
  function protectApiKey(plainText) {
    var script = "$ErrorActionPreference='Stop'; $b=[Console]::In.ReadToEnd(); $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)); $ss=ConvertTo-SecureString -String $s -AsPlainText -Force; ConvertFrom-SecureString -SecureString $ss";
    return powershell(script, plainText);
  }
  function unprotectApiKey(cipherText) {
    var script = "$ErrorActionPreference='Stop'; $b=[Console]::In.ReadToEnd(); $c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)); $ss=ConvertTo-SecureString -String $c; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); try { $s=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }";
    return powershell(script, cipherText).then(function (encoded) { return Buffer.from(encoded, 'base64').toString('utf8'); });
  }
  function saveApiKey(plainText) {
    if (!plainText) return Promise.reject(new Error('API Key 不能为空。'));
    return protectApiKey(plainText).then(function (cipherText) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, cipherText, { encoding: 'utf8', mode: 0o600 });
      return true;
    });
  }
  function loadApiKey() {
    if (!fs.existsSync(file)) return Promise.resolve('');
    return unprotectApiKey(fs.readFileSync(file, 'utf8'));
  }
  root.HardSubtitleCredentialStore = { protectApiKey: protectApiKey, unprotectApiKey: unprotectApiKey, saveApiKey: saveApiKey, loadApiKey: loadApiKey };
}(this));
