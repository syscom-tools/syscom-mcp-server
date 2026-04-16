# syscom-mcp-server

MCP server para [Syscom](https://www.syscom.mx) que conecta clientes stdio (Claude Desktop, Cursor, OpenClaw, etc.) al servidor MCP de Syscom.

Cero dependencias. Solo necesita Node.js.

## Requisitos

- Node.js 20.9+
- Token MCP de Syscom (obtenlo en [syscom.mx/mcp](https://www.syscom.mx/mcp))

## Configuracion en tu cliente MCP

### Claude Desktop / Cursor / OpenClaw

Agrega esto a tu configuracion de MCP:

```json
{
  "mcpServers": {
    "syscom": {
      "command": "npx",
      "args": ["-y", "github:syscom-tools/syscom-mcp-server"],
      "env": {
        "MCP_TOKEN": "su_token"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http syscom https://www.syscom.mx/api/mcp --header "Authorization: Bearer su_token"
```

## Comprobar conexión

```bash
MCP_TOKEN=tu_token npx -y github:syscom-tools/syscom-mcp-server
```

## Variables de entorno

| Variable    | Requerida | Default | Descripcion                        |
|-------------|-----------|---------|--------------------------------------|
| `MCP_TOKEN` | Opcional  | —       | JWT token de syscom.mx/mcp           |

## Herramientas disponibles

Las herramientas dependen de los privilegios de tu cuenta:

**Todos los usuarios:**
- `search_syscom_products` — Buscar productos en el catalogo
- `search_knowledge_base` — Buscar en la base de conocimiento
- `get_delivery_time` — Consultar tiempos de entrega
- `buscar_cursos` — Buscar cursos disponibles
- `ver_carrito` — Ver carrito de compras
- `eliminar_del_carrito` — Eliminar productos del carrito
- `mi_cuenta` — Informacion de tu cuenta
- `mis_facturas` — Consultar facturas

**Con privilegio 'comprar':**
- `add_to_cart` — Agregar productos al carrito
- `modificar_cantidad_carrito` — Modificar cantidades

**Con privilegio 'crear_RMA':**
- `preparar_devolucion` — Preparar una devolucion
- `crear_devolucion` — Crear una devolucion
- `consultar_devoluciones` — Consultar devoluciones

## Licencia

MIT
