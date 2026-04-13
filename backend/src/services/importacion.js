/**
 * Servicio de importación de Excel
 *
 * Formato real detectado en "modelo de excel a subir.xlsx":
 *   - Columnas: "Club  ", "Asociación  ", "Fecha  ", "Tipo Rodeo  ", "Nombre Jurado  "
 *     (todas tienen espacios al final → se normalizan con .trim())
 *   - Fechas: formato M/D/YY de Excel USA → "2/25/26" = 25-Feb-2026
 *   - Club: puede venir vacío (se guarda como "Sin club")
 *   - Nombres: MAYÚSCULAS o mixto → se normalizan sin tildes para matching
 *   - Guiones en tipos de rodeo: "Provincial - Un Día" se normaliza igual que "Provincial Un Dia"
 */

const XLSX    = require('xlsx');
const supabase = require('../config/supabase');
const { calcularPagoBase, obtenerTarifas } = require('./calculo');
const auditoria = require('./auditoria');

// ─── Normalización ────────────────────────────────────────────
/**
 * Normaliza un string para matching:
 * - trim, minúsculas
 * - sin tildes / diacríticos
 * - guiones, em-dash y múltiples espacios → espacio simple
 */
function normalizar(str) {
    if (!str) return '';
    return str.toString()
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')   // quitar tildes
        .replace(/[\-–—]+/g, ' ')          // guiones a espacio
        .replace(/\s+/g, ' ')              // múltiples espacios a uno
        .trim();
}

// ─── Parser de fecha ──────────────────────────────────────────
/**
 * Convierte distintos formatos de fecha a 'YYYY-MM-DD'.
 *
 * Maneja:
 *   "2/25/26"   → "2026-02-25"   (M/D/YY — formato real del Excel)
 *   "25/02/2026"→ "2026-02-25"   (D/M/YYYY)
 *   "2026-02-25"→ "2026-02-25"   (ya normalizado)
 *   número      → serial Excel
 *   Date object → ISO
 */
function parsearFecha(valor) {
    if (!valor && valor !== 0) return null;

    // Date object (xlsx con cellDates:true)
    if (valor instanceof Date) {
        if (isNaN(valor.getTime())) return null;
        const y = valor.getFullYear();
        const m = String(valor.getMonth() + 1).padStart(2, '0');
        const d = String(valor.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    // Número serial de Excel
    if (typeof valor === 'number') {
        const fecha = XLSX.SSF.parse_date_code(valor);
        if (!fecha) return null;
        return `${fecha.y}-${String(fecha.m).padStart(2,'0')}-${String(fecha.d).padStart(2,'0')}`;
    }

    const s = String(valor).trim();

    // ISO YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    // M/D/YY o M/D/YYYY (formato real detectado: "2/25/26")
    const matchMDY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (matchMDY) {
        const mes = matchMDY[1].padStart(2, '0');
        const dia = matchMDY[2].padStart(2, '0');
        let año = parseInt(matchMDY[3], 10);
        if (año < 100) año += año >= 50 ? 1900 : 2000;  // "26" → 2026
        // Validar que sea fecha real
        const dt = new Date(año, parseInt(mes,10)-1, parseInt(dia,10));
        if (isNaN(dt.getTime())) return null;
        return `${año}-${mes}-${dia}`;
    }

    // D/M/YYYY o D-M-YYYY
    const matchDMY = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (matchDMY) {
        return `${matchDMY[3]}-${matchDMY[2].padStart(2,'0')}-${matchDMY[1].padStart(2,'0')}`;
    }

    return null;
}

// ─── Extractor de columnas ────────────────────────────────────
/**
 * Extrae los 5 campos requeridos de una fila del Excel,
 * tolerando nombres de columna con espacios, tildes y variaciones.
 *
 * Mapeo detectado en el archivo real:
 *   "Club  "          → club
 *   "Asociación  "    → asociacion
 *   "Fecha  "         → fecha
 *   "Tipo Rodeo  "    → tipo_rodeo
 *   "Nombre Jurado  " → nombre_jurado
 */
function extraerCampos(filaRaw) {
    // Normalizar claves: quitar espacios
    const fila = {};
    Object.keys(filaRaw).forEach(k => {
        fila[k.trim()] = filaRaw[k];
    });

    const buscar = (...aliases) => {
        for (const alias of aliases) {
            // Buscar exacto
            if (fila[alias] !== undefined && fila[alias] !== '') {
                const v = fila[alias];
                return typeof v === 'string' ? v.trim() : v;
            }
            // Buscar insensible a mayúsculas/espacios
            const normAlias = normalizar(alias);
            const keyEncontrada = Object.keys(fila).find(k => normalizar(k) === normAlias);
            if (keyEncontrada && fila[keyEncontrada] !== undefined && fila[keyEncontrada] !== '') {
                const v = fila[keyEncontrada];
                return typeof v === 'string' ? v.trim() : v;
            }
        }
        return null;
    };

    return {
        club:          buscar('Club', 'club', 'CLUB', 'Club  ', 'nombre club') || '',
        asociacion:    buscar('Asociación', 'Asociacion', 'asociacion', 'Asociación  ', 'ASOCIACION', 'asoc', 'region') || '',
        fecha:         buscar('Fecha', 'fecha', 'FECHA', 'Fecha  ', 'date', 'fecha_rodeo'),
        tipo_rodeo:    buscar('Tipo Rodeo', 'tipo_rodeo', 'TIPO_RODEO', 'Tipo Rodeo  ', 'TipoRodeo', 'tipo de rodeo', 'tipo'),
        nombre_jurado: buscar('Nombre Jurado', 'nombre_jurado', 'NOMBRE_JURADO', 'Nombre Jurado  ', 'Jurado', 'jurado', 'nombre')
    };
}

// ─── Helper: objeto _campos limpio para pendientes ────────────
/**
 * Construye el objeto _campos con valores extraídos y limpios
 * para guardar en datos_originales de cada registro pendiente.
 */
function buildCampos(campos, extras = {}) {
    return {
        club:          campos.club || '',
        asociacion:    campos.asociacion || '',
        fecha_original: campos.fecha !== null && campos.fecha !== undefined ? String(campos.fecha) : '',
        tipo_rodeo:    campos.tipo_rodeo || '',
        nombre_jurado: campos.nombre_jurado || '',
        ...extras
    };
}

/**
 * Busca jurados similares por coincidencia de palabras.
 * Devuelve hasta maxRes objetos { id, nombre, categoria }.
 */
function buscarJuradosSimilares(nombreNorm, mapaJurados, maxRes = 5) {
    const palabras = nombreNorm.split(' ').filter(p => p.length >= 4);
    const resultados = [];
    for (const [k, v] of Object.entries(mapaJurados)) {
        if (palabras.some(p => k.includes(p))) {
            resultados.push({ id: v.id, nombre: v.nombre_completo, categoria: v.categoria });
            if (resultados.length >= maxRes) break;
        }
    }
    return resultados;
}

// ─── Proceso principal ────────────────────────────────────────
/**
 * Procesa un buffer de Excel e inserta rodeos y asignaciones.
 *
 * @param {Buffer} buffer
 * @param {string} nombreArchivo
 * @param {string} adminId
 * @param {string} adminIp
 * @returns {Object} resumen { importacion_id, total, insertadas, pendientes, duplicadas, errores }
 */
async function procesarImportacion(buffer, nombreArchivo, adminId, adminIp) {
    // ── 1. Parsear Excel ──────────────────────────────────────
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // raw:false para que las fechas numéricas vengan como string,
    // pero cellDates:true las convierte a Date cuando XLSX las detecta
    const filasRaw = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!filasRaw.length) {
        throw new Error('El archivo Excel está vacío o no tiene filas de datos');
    }

    // ── 2. Cargar catálogos en memoria ────────────────────────
    const tarifas = await obtenerTarifas();

    const { data: tiposDB } = await supabase
        .from('tipos_rodeo')
        .select('id, nombre, duracion_dias')
        .eq('activo', true);

    const { data: usuariosDB } = await supabase
        .from('usuarios_pagados')
        .select('id, nombre_completo, tipo_persona, categoria')
        .eq('activo', true)
        .eq('tipo_persona', 'jurado');

    // Mapas normalizados para búsqueda O(1)
    const mapaTipos = {};
    (tiposDB || []).forEach(t => {
        mapaTipos[normalizar(t.nombre)] = t;
    });

    const mapaJurados = {};
    (usuariosDB || []).forEach(u => {
        mapaJurados[normalizar(u.nombre_completo)] = u;
    });

    // ── 3. Registrar importación ──────────────────────────────
    const { data: importacion, error: errImp } = await supabase
        .from('importaciones')
        .insert({
            nombre_archivo: nombreArchivo,
            total_filas:    filasRaw.length,
            created_by:     adminId
        })
        .select()
        .single();

    if (errImp) throw new Error('Error al registrar importación: ' + errImp.message);

    const impId = importacion.id;

    // ── 4. Clasificar filas ───────────────────────────────────
    let insertadas = 0, pendientes = 0, duplicadas = 0, errores = 0;
    const pendientesBatch  = [];
    const listas           = [];  // filas OK para insertar

    for (let i = 0; i < filasRaw.length; i++) {
        const campos = extraerCampos(filasRaw[i]);
        const numFila = i + 2;  // +2 porque la fila 1 es el encabezado

        // ── 4a. Validar campos mínimos ────────────────────────
        if (!campos.fecha || !campos.tipo_rodeo || !campos.nombre_jurado) {
            pendientesBatch.push({
                importacion_id:   impId,
                datos_originales: {
                    ...filasRaw[i],
                    _fila:   numFila,
                    _campos: buildCampos(campos, {
                        _motivo: `Falta: ${[!campos.fecha&&'fecha', !campos.tipo_rodeo&&'tipo rodeo', !campos.nombre_jurado&&'nombre jurado'].filter(Boolean).join(', ')}`
                    })
                },
                problema: 'datos_incompletos'
            });
            pendientes++;
            continue;
        }

        // ── 4b. Parsear fecha ─────────────────────────────────
        const fechaNorm = parsearFecha(campos.fecha);
        if (!fechaNorm) {
            pendientesBatch.push({
                importacion_id:   impId,
                datos_originales: {
                    ...filasRaw[i],
                    _fila:   numFila,
                    _campos: buildCampos(campos, { _motivo: `Fecha inválida: "${campos.fecha}"` })
                },
                problema: 'datos_incompletos'
            });
            pendientes++;
            continue;
        }

        // ── 4c. Buscar tipo de rodeo ──────────────────────────
        const tipoKey    = normalizar(campos.tipo_rodeo);
        const tipoEncontrado = mapaTipos[tipoKey];

        if (!tipoEncontrado) {
            // Buscar tipos similares para sugerencias (con id)
            const similaresTipos = Object.keys(mapaTipos)
                .filter(k => k.includes(tipoKey.slice(0, 8)) || tipoKey.includes(k.slice(0, 8)))
                .slice(0, 5)
                .map(k => {
                    const t = (tiposDB || []).find(t => normalizar(t.nombre) === k);
                    return t ? { id: t.id, nombre: t.nombre, duracion_dias: t.duracion_dias } : null;
                })
                .filter(Boolean);

            pendientesBatch.push({
                importacion_id:   impId,
                datos_originales: {
                    ...filasRaw[i],
                    _fila:      numFila,
                    _similares: similaresTipos,
                    _campos:    buildCampos(campos, { fecha_norm: fechaNorm })
                },
                problema: 'tipo_rodeo_no_encontrado'
            });
            pendientes++;
            continue;
        }

        // ── 4d. Buscar jurado ─────────────────────────────────
        const juradoKey      = normalizar(campos.nombre_jurado);
        const juradoEncontrado = mapaJurados[juradoKey];

        if (!juradoEncontrado) {
            const similaResJurados = buscarJuradosSimilares(juradoKey, mapaJurados, 5);

            pendientesBatch.push({
                importacion_id:   impId,
                datos_originales: {
                    ...filasRaw[i],
                    _fila:      numFila,
                    _similares: similaResJurados,
                    _campos:    buildCampos(campos, { fecha_norm: fechaNorm, tipo_rodeo_id: tipoEncontrado.id })
                },
                problema: 'jurado_no_encontrado'
            });
            pendientes++;
            continue;
        }

        // ── 4e. Detectar duplicado ────────────────────────────
        // Clave: misma fecha + mismo club + mismo tipo_rodeo + mismo jurado
        const dupKey = `${fechaNorm}|${normalizar(campos.club)}|${tipoEncontrado.id}|${juradoEncontrado.id}`;
        // También verificar contra registros ya procesados en este lote
        const dupEnLote = listas.some(l => l._dupKey === dupKey);

        if (dupEnLote) {
            pendientesBatch.push({
                importacion_id:   impId,
                datos_originales: {
                    ...filasRaw[i],
                    _fila:   numFila,
                    _campos: buildCampos(campos, { fecha_norm: fechaNorm, _motivo: 'Duplicado en el mismo archivo' })
                },
                problema: 'duplicado'
            });
            duplicadas++;
            continue;
        }

        // Verificar contra la base de datos
        const { data: rodeosDup } = await supabase
            .from('rodeos')
            .select('id')
            .eq('fecha', fechaNorm)
            .ilike('club', campos.club || '')
            .eq('tipo_rodeo_id', tipoEncontrado.id);

        let esDuplicadoDB = false;
        if (rodeosDup && rodeosDup.length > 0) {
            const rodeoIds = rodeosDup.map(r => r.id);
            const { data: asigDup } = await supabase
                .from('asignaciones')
                .select('id')
                .in('rodeo_id', rodeoIds)
                .eq('usuario_pagado_id', juradoEncontrado.id)
                .neq('estado', 'anulado')
                .limit(1);

            esDuplicadoDB = asigDup && asigDup.length > 0;
        }

        if (esDuplicadoDB) {
            pendientesBatch.push({
                importacion_id:   impId,
                datos_originales: {
                    ...filasRaw[i],
                    _fila:   numFila,
                    _campos: buildCampos(campos, { fecha_norm: fechaNorm, _motivo: 'Ya existe en la base de datos' })
                },
                problema: 'duplicado'
            });
            duplicadas++;
            continue;
        }

        // ── 4f. Calcular pago ─────────────────────────────────
        let calculo;
        try {
            calculo = calcularPagoBase(
                'jurado',
                juradoEncontrado.categoria,
                tipoEncontrado.duracion_dias,
                tarifas
            );
        } catch (calcErr) {
            pendientesBatch.push({
                importacion_id:   impId,
                datos_originales: {
                    ...filasRaw[i],
                    _fila:   numFila,
                    _campos: buildCampos(campos, { fecha_norm: fechaNorm, _motivo: calcErr.message })
                },
                problema: 'datos_incompletos'
            });
            errores++;
            continue;
        }

        // ── 4g. Listo para insertar ───────────────────────────
        listas.push({
            _dupKey:          dupKey,
            club:             campos.club || 'Sin club',
            asociacion:       campos.asociacion || 'Sin asociación',
            fechaNorm,
            tipoEncontrado,
            juradoEncontrado,
            calculo,
            nombreOriginal:   campos.nombre_jurado
        });
    }

    // ── 5. Insertar filas OK ──────────────────────────────────
    for (const item of listas) {
        try {
            const { club, asociacion, fechaNorm, tipoEncontrado, juradoEncontrado, calculo, nombreOriginal } = item;

            // Buscar o crear rodeo (agrupamos por fecha + club + tipo)
            let rodeoId;
            const { data: rodeoExistente } = await supabase
                .from('rodeos')
                .select('id')
                .eq('fecha', fechaNorm)
                .ilike('club', club)
                .eq('tipo_rodeo_id', tipoEncontrado.id)
                .neq('estado', 'anulado')
                .limit(1);

            if (rodeoExistente && rodeoExistente.length > 0) {
                rodeoId = rodeoExistente[0].id;
            } else {
                const { data: nuevoRodeo, error: errR } = await supabase
                    .from('rodeos')
                    .insert({
                        club,
                        asociacion,
                        fecha:             fechaNorm,
                        tipo_rodeo_id:     tipoEncontrado.id,
                        tipo_rodeo_nombre: tipoEncontrado.nombre,
                        duracion_dias:     tipoEncontrado.duracion_dias,
                        origen:            'importado',
                        importacion_id:    impId,
                        created_by:        adminId
                    })
                    .select('id')
                    .single();

                if (errR) throw new Error('Error al crear rodeo: ' + errR.message);
                rodeoId = nuevoRodeo.id;
            }

            // Crear asignación
            // estado_designacion = 'pendiente': el jurado debe aceptar/rechazar explícitamente.
            // NUNCA omitir este campo: omitirlo deja NULL, que el sistema trata como 'aceptado'.
            const { error: errA } = await supabase
                .from('asignaciones')
                .insert({
                    rodeo_id:               rodeoId,
                    usuario_pagado_id:      juradoEncontrado.id,
                    tipo_persona:           'jurado',
                    nombre_importado:       nombreOriginal,
                    categoria_aplicada:     calculo.categoria_aplicada,
                    valor_diario_aplicado:  calculo.valor_diario_aplicado,
                    duracion_dias_aplicada: tipoEncontrado.duracion_dias,
                    pago_base_calculado:    calculo.pago_base_calculado,
                    estado:                 'activo',
                    estado_designacion:     'pendiente',
                    created_by:             adminId
                });

            if (errA) throw new Error('Error al crear asignación: ' + errA.message);
            insertadas++;

        } catch (err) {
            errores++;
            console.error('[IMPORTACION] Error al insertar fila:', err.message);
        }
    }

    // ── 6. Insertar pendientes en batch ───────────────────────
    if (pendientesBatch.length > 0) {
        const BATCH = 50;
        for (let i = 0; i < pendientesBatch.length; i += BATCH) {
            await supabase
                .from('importaciones_pendientes')
                .insert(pendientesBatch.slice(i, i + BATCH));
        }
    }

    // ── 7. Actualizar resumen de importación ──────────────────
    await supabase
        .from('importaciones')
        .update({ insertadas, pendientes, duplicadas, errores })
        .eq('id', impId);

    // ── 8. Auditoría ──────────────────────────────────────────
    await auditoria.registrar({
        tabla:        'importaciones',
        registro_id:  impId,
        accion:       'importar_excel',
        datos_nuevos: { nombre_archivo: nombreArchivo, insertadas, pendientes, duplicadas, errores },
        actor_id:     adminId,
        actor_tipo:   'administrador',
        descripcion:  `Excel "${nombreArchivo}" — OK:${insertadas} Pend:${pendientes} Dup:${duplicadas} Err:${errores}`,
        ip_address:   adminIp
    });

    return {
        importacion_id: impId,
        total:          filasRaw.length,
        insertadas,
        pendientes,
        duplicadas,
        rechazadas:     0,
        errores
    };
}

// Exportar también las utilidades para usarlas en resolución de pendientes
module.exports = { procesarImportacion, normalizar, parsearFecha };
