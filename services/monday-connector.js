const fetch = require('node-fetch');

const EDGE_FUNCTION_BASE = 'https://vqlesrbrrxscydvjjeux.supabase.co/functions/v1/railway-proxy';

class MondayConnector {
  constructor() {
    this.apiUrl = 'https://api.monday.com/v2';
    this.apiKey = null;
    this.configuracion = null;
  }

  async obtenerConfiguracion() {
    try {
      const response = await fetch(`${EDGE_FUNCTION_BASE}/obtener-configuracion-crm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo_crm: 'monday' })
      });

      const result = await response.json();

      if (result.success && result.configuracion) {
        this.configuracion = result.configuracion;
        this.apiKey = result.configuracion.credenciales?.api_key;
        return result.configuracion;
      }

      return null;
    } catch (error) {
      console.error('❌ Error obteniendo configuración:', error);
      return null;
    }
  }

  async ejecutarQuery(query) {
    if (!this.apiKey) {
      await this.obtenerConfiguracion();
    }

    if (!this.apiKey) {
      throw new Error('API key de Monday no configurada');
    }

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.apiKey,
          'API-Version': '2024-01'
        },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        throw new Error(`Monday API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('❌ Error ejecutando query Monday:', error);
      throw error;
    }
  }

  async obtenerItems(boardId) {
    const query = `
      query {
        boards (ids: [${boardId}]) {
          columns {
            id
            title
            type
          }
          items_page (limit: 500) {
            items {
              id
              name
              column_values {
                id
                text
                value
              }
            }
          }
        }
      }
    `;

    const result = await this.ejecutarQuery(query);
    const board = result.data.boards[0];

    return {
      columns: board.columns,
      items: board.items_page?.items || []
    };
  }

  extraerDatosCliente(item, columns, boardInfo) {
    let nombre = item.name || null;
    let telefono = null;
    let email = null;
    let empresa = null;

    for (const col of item.column_values) {
      if (!col.text) continue;

      const columnDef = columns.find(c => c.id === col.id);
      if (!columnDef) continue;

      const titulo = columnDef.title.toLowerCase();

      // Detectar teléfono
      if (titulo.includes('phone') || titulo.includes('teléfono') ||
          titulo.includes('telefono') || titulo.includes('celular')) {
        telefono = col.text.replace(/\D/g, ''); // Solo números
      }

      // Detectar email
      if (titulo.includes('email') || titulo.includes('correo') || titulo.includes('e-mail')) {
        email = col.text.trim();
      }

      // Detectar empresa
      if (titulo.includes('empresa') || titulo.includes('company') || titulo.includes('compañía')) {
        empresa = col.text.trim();
      }
    }

    return {
      nombre,
      telefono: telefono || null,
      email: email || null,
      empresa: empresa || null,
      metadata_crm: {
        monday_item_id: item.id,
        monday_item_name: item.name,
        board_id: boardInfo.id,
        board_name: boardInfo.name
      }
    };
  }

  async sincronizarTodos() {
    console.log('🔄 Iniciando sincronización de Monday...');
    const startTime = Date.now();

    try {
      // 1. Obtener configuración
      const config = await this.obtenerConfiguracion();

      if (!config) {
        console.log('⚠️ No hay configuración de Monday activa');
        console.log('💡 Ve a /configuracion/crm para configurar Monday');
        return;
      }

      const boardsSeleccionados = config.configuracion?.boards_seleccionados;

      if (!boardsSeleccionados || boardsSeleccionados.length === 0) {
        console.log('⚠️ No hay boards seleccionados para sincronizar');
        console.log('💡 Ve a /configuracion/crm y selecciona al menos un board');
        return;
      }

      console.log(`📋 Sincronizando ${boardsSeleccionados.length} boards configurados`);

      let totalClientes = 0;
      let totalActualizados = 0;
      let totalCreados = 0;

      // 2. Sincronizar cada board seleccionado
      for (const boardInfo of boardsSeleccionados) {
        console.log(`\n📊 Procesando board: "${boardInfo.name}" (ID: ${boardInfo.id})`);

        const { columns, items } = await this.obtenerItems(boardInfo.id);
        console.log(`   Encontrados ${items.length} items`);

        // 3. Por cada item, extraer datos y guardar
        for (const item of items) {
          const datosCliente = this.extraerDatosCliente(item, columns, boardInfo);

          // Solo sincronizar si tiene teléfono o email
          if (datosCliente.telefono || datosCliente.email) {
            const resultado = await this.guardarCliente(datosCliente);

            if (resultado.success) {
              if (resultado.accion === 'creado') {
                totalCreados++;
              } else if (resultado.accion === 'actualizado') {
                totalActualizados++;
              }
              totalClientes++;
            }

            // Log cada 10 clientes
            if (totalClientes % 10 === 0) {
              console.log(`   ✅ Procesados ${totalClientes} clientes...`);
            }
          }
        }
      }

      const duracion = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`\n✅ Sincronización completa en ${duracion}s`);
      console.log(`   📊 Total: ${totalClientes} clientes`);
      console.log(`   🆕 Creados: ${totalCreados}`);
      console.log(`   🔄 Actualizados: ${totalActualizados}`);

      // Actualizar última sincronización
      await this.actualizarUltimaSincronizacion();

    } catch (error) {
      console.error('❌ Error en sincronización Monday:', error);
    }
  }

  async guardarCliente(datosCliente) {
    try {
      const response = await fetch(`${EDGE_FUNCTION_BASE}/sincronizar-cliente-crm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(datosCliente)
      });

      return await response.json();
    } catch (error) {
      console.error('❌ Error guardando cliente:', error);
      return { success: false };
    }
  }

  async actualizarUltimaSincronizacion() {
    try {
      await fetch(`${EDGE_FUNCTION_BASE}/actualizar-sincronizacion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo_crm: 'monday' })
      });
    } catch (error) {
      // No crítico, solo log
      console.log('⚠️ No se pudo actualizar timestamp de sincronización');
    }
  }
}

module.exports = MondayConnector;
