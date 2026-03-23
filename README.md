# Vector Baileys Server

Servidor Node.js que mantiene conexiones activas de WhatsApp usando Baileys para el sistema de supervisión de vendedores **Vector**.

## Arquitectura

```
├── index.js              # Punto de entrada - HTTP arranca primero
├── routes/
│   ├── qr.js             # GET /api/qr/:sessionId, POST /api/sesion/:id
│   └── api.js            # POST /api/enviar, GET /api/sesiones
├── sessions/
│   ├── supervisor.js     # Sesiones de solo lectura (una por vendedor)
│   └── bot-central.js    # Sesión única que puede enviar mensajes
└── services/
    ├── claude.js         # Análisis con Claude API
    ├── supabase.js       # Operaciones de base de datos
    └── alertas.js        # Motor de alertas (cron cada 6h)
```

## Instalación local

```bash
# 1. Clonar e instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Edita .env con tus credenciales reales

# 3. Arrancar
npm start
```

## Variables de entorno

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | API key de Anthropic | `sk-ant-...` |
| `SUPABASE_URL` | URL de tu proyecto Supabase | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service key de Supabase | `eyJ...` |
| `PORT` | Puerto HTTP (default: 3000) | `3000` |
| `GERENTES_NUMEROS` | Números autorizados en Bot Central (con código de país, sin +) | `5219991234567,5219997654321` |
| `ALERT_THRESHOLD_DAYS` | Días de inactividad para generar alerta (default: 3) | `3` |

## Endpoints HTTP

### Health check
```
GET /api/health
```
```json
{ "status": "ok", "timestamp": "...", "sesiones": { "supervisores": [...], "botCentral": "conectado" } }
```

### Obtener QR de una sesión
```
GET /api/qr/:sessionId
```
- `sessionId` puede ser `bot-central` o el ID de un vendedor
- Respuestas: `{ status: "esperando_qr", qr: "data:image/png;base64,..." }` o `{ status: "conectado", qr: null }`

### Iniciar sesión supervisor para un vendedor
```
POST /api/sesion/:vendedorId
```

### Enviar mensaje (solo Bot Central)
```
POST /api/enviar
Body: { "numero": "5219991234567", "mensaje": "Hola..." }
```

### Listar sesiones activas
```
GET /api/sesiones
```

## Flujo de conexión QR

1. Consultar `/api/qr/bot-central` → muestra QR en base64
2. Escanear con el número del Bot Central
3. Estado cambia a `conectado`
4. Para supervisores: `POST /api/sesion/{vendedorId}` → luego `GET /api/qr/{vendedorId}`

## Tablas de Supabase requeridas

```sql
-- conversaciones
create table conversaciones (
  id uuid default gen_random_uuid() primary key,
  vendedor_id text not null,
  prospecto_numero text not null,
  ultima_actividad timestamptz default now()
);

-- mensajes
create table mensajes (
  id uuid default gen_random_uuid() primary key,
  conversacion_id uuid references conversaciones(id),
  texto text,
  direccion text check (direccion in ('entrante', 'saliente')),
  analisis_claude jsonb,
  timestamp timestamptz default now()
);

-- alertas
create table alertas (
  id uuid default gen_random_uuid() primary key,
  vendedor_id text not null,
  tipo text not null,
  mensaje text,
  enviada_at timestamptz,
  created_at timestamptz default now()
);
```

## Despliegue en Railway

### 1. Preparar repositorio

```bash
git init
git add .
git commit -m "Initial commit"
```

Sube a GitHub.

### 2. Crear proyecto en Railway

1. Ve a [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Selecciona tu repositorio

### 3. Configurar variables de entorno en Railway

En el panel de Railway → tu servicio → **Variables**, agrega:

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
GERENTES_NUMEROS=5219991234567
ALERT_THRESHOLD_DAYS=3
```

Railway asigna `PORT` automáticamente — no la configures manualmente.

### 4. Verificar despliegue

El servidor arranca inmediatamente. Verifica:
```
https://tu-servicio.railway.app/api/health
```

### 5. Escanear QR

Una vez activo:
```
https://tu-servicio.railway.app/api/qr/bot-central
```

⚠️ **Importante**: Las sesiones se guardan en `./sessions_data/` dentro del contenedor. En Railway el filesystem es efímero. Para persistencia entre reinicios, considera usar Railway Volumes o guardar las credenciales de Baileys en Supabase Storage.

## Persistencia de sesiones en Railway (recomendado)

Railway reinicia el contenedor periódicamente. Para no tener que re-escanear QR en cada reinicio, habilita un **Volume** en Railway:

1. En tu servicio → **Volumes** → **Add Volume**
2. Mount Path: `/app/sessions_data`

Esto persiste el directorio de sesiones entre reinicios.

## Conexión con Lovable (frontend)

El frontend en Lovable puede:
1. Llamar `GET /api/qr/{sessionId}` para mostrar el QR como `<img src={qr} />`
2. Llamar `GET /api/sesiones` para mostrar estados
3. Llamar `POST /api/enviar` para enviar mensajes desde la UI

Agrega el dominio de Railway en tus variables de entorno del frontend de Lovable.
