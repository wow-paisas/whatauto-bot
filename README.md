# INMITI WhataAuto Bot

Bot de WhatsApp que responde mensajes automáticamente usando las reglas configuradas en el panel web.

## Deploy en Railway (gratis)

### 1. Obtener tu API Token
1. Abre https://inmiti.site/autoresponder
2. Inicia sesión
3. Ve a **Perfil** → copia tu **Token API**

### 2. Subir a GitHub
```bash
git init
git add .
git commit -m "bot whatauto"
# Crear repo en github.com y hacer push
git remote add origin https://github.com/TU_USUARIO/whatauto-bot.git
git push -u origin main
```

### 3. Desplegar en Railway
1. Ve a https://railway.app y crea cuenta (gratis)
2. **New Project** → **Deploy from GitHub repo**
3. Selecciona tu repositorio
4. En **Variables**, agrega:
   - `API_TOKEN` = (tu token del perfil)
   - `API_URL` = `https://inmiti.site/autoresponder/api/index.php`

### 4. Escanear QR
1. En Railway, ve a **Deployments** → click en el deployment activo → **View Logs**
2. Aparecerá un QR en los logs
3. En WhatsApp: **Dispositivos vinculados** → **Vincular dispositivo** → escanea el QR
4. ¡Listo! El bot ya responde automáticamente

## Cómo funciona
- Cada mensaje privado recibido se consulta contra tu API
- Si hay una regla que hace match, responde automáticamente
- Los grupos son ignorados
- Registra todo en los logs del panel web
