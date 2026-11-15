import { Menu, MenuButton, MenuItem, MenuItems, Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { LuEllipsis, LuGrid3X3, LuHand, LuInfo, LuLayoutGrid, LuLink, LuMap, LuMousePointer2, LuPlus, LuRefreshCw, LuSearch, LuUndo2 } from "react-icons/lu";
import type { Tool } from "./types";

interface Props {
  tool: Tool;
  explorerOpen: boolean;
  snap: boolean;
  minimap: boolean;
  disabled: boolean;
  canUndo: boolean;
  undoBusy: boolean;
  onTool: (tool: Tool) => void;
  onExplorer: () => void;
  onSnap: () => void;
  onMinimap: () => void;
  onAdd: () => void;
  onPopulate: () => void;
  onRefresh: () => void;
  onUndo: () => void;
}
export default function MapToolbar(props: Props) {
  return <div className="netmap-toolbar" role="toolbar" aria-label="Map tools">
    <div className="netmap-tool-group" aria-label="Canvas tool">
      {([{ tool: "select", label: "Select", key: "V", icon: LuMousePointer2 }, { tool: "pan", label: "Pan", key: "H", icon: LuHand }, { tool: "connect", label: "Link", key: "C", icon: LuLink }, { tool: "add", label: "Place", key: "A", icon: LuPlus }] as const).map(({ tool, label, key, icon: Icon }) => <button key={tool} aria-pressed={props.tool === tool} disabled={props.disabled} onClick={() => props.onTool(tool)} title={`${label} (${key})`}><Icon size={15} /><span>{label}</span></button>)}
    </div>
    <div className="netmap-toolbar-actions">
      <button className="netmap-button netmap-primary" onClick={props.onAdd} disabled={props.disabled}><LuPlus size={15} />Add device</button>
      <button className="netmap-button" onClick={props.onExplorer} aria-pressed={props.explorerOpen} title="Find device (Ctrl+F)"><LuSearch size={15} /><span>Devices</span></button>
      <button className="netmap-icon-button" aria-label="Snap to grid" aria-pressed={props.snap} onClick={props.onSnap} title="Snap to grid (G)"><LuGrid3X3 size={16} /></button>
      <button className="netmap-icon-button" aria-label="Show overview" aria-pressed={props.minimap} onClick={props.onMinimap} title="Overview (M)"><LuMap size={16} /></button>
      <button className="netmap-icon-button" aria-label="Undo deletion" onClick={props.onUndo} disabled={!props.canUndo || props.disabled || props.undoBusy} title="Undo deletion (Ctrl+Z)"><LuUndo2 size={16} /></button>
      <Popover className="relative">
        <PopoverButton className="netmap-icon-button" aria-label="Map keyboard shortcuts" title="Controls and shortcuts"><LuInfo size={16} /></PopoverButton>
        <PopoverPanel portal anchor="bottom end" className="netmap-popup netmap-help">
          <strong>Move around the map</strong><p>Scroll to pan. Ctrl + scroll to zoom at the pointer. Use Pan or hold Space to drag the canvas.</p>
          <dl><dt>V / H / C / A</dt><dd>Select / Pan / Link / Place</dd><dt>Ctrl + F</dt><dd>Find a device</dd><dt>Ctrl + Shift + F</dt><dd>Fit the whole map</dd><dt>Ctrl + Z</dt><dd>Undo deletion</dd><dt>G / M</dt><dd>Grid snap / Overview</dd><dt>Delete</dt><dd>Remove selected item</dd><dt>Escape</dt><dd>Cancel tool or selection</dd></dl>
          <p>Select a link to edit its properties or drag its waypoint handles. Double-click a device to rename it.</p>
        </PopoverPanel>
      </Popover>
      <Menu as="div" className="relative">
        <MenuButton className="netmap-icon-button" aria-label="More map actions"><LuEllipsis size={17} /></MenuButton>
        <MenuItems portal anchor="bottom end" className="netmap-popup netmap-actions-menu">
          <MenuItem><button disabled={props.disabled} onClick={props.onPopulate}><LuLayoutGrid size={15} /><span>Add all saved hosts<small>Keep existing devices and links</small></span></button></MenuItem>
          <MenuItem><button disabled={props.disabled} onClick={props.onRefresh}><LuRefreshCw size={15} />Reload map</button></MenuItem>
        </MenuItems>
      </Menu>
    </div>
  </div>;
}
