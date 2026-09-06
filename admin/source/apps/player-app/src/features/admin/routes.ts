import { Database } from "@shared/icons";
import { ScreenDefinition } from "@app/shell/routeTypes";

export const adminRoutes = [
  {
    caption: "Admin",
    icon: Database,
    module: "admin",
    path: "/admin",
    primary: true,
    rune: "DB",
    screen: "Admin",
    tone: "slate",
  },
] as const satisfies readonly ScreenDefinition[];
