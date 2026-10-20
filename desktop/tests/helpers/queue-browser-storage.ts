/** Explicit browser storage: Node 26's native localStorage can mask jsdom's implementation. */
export function queueBrowserStorage(): Storage {
 const values=new Map<string,string>();return {get length(){return values.size;},key:index=>[...values.keys()][index]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,String(value));},removeItem:key=>{values.delete(key);},clear:()=>values.clear()};
}
