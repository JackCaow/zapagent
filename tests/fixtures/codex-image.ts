export function imagePreload(base64: string): string {
  return `let calls = 0; globalThis.fetch = async (url, init) => {
    if (String(url).includes("/models?")) return Response.json({models:[{slug:"account-model",supported_reasoning_levels:[{effort:"low"}],default_reasoning_level:"low"}]});
    if (String(url) !== "https://chatgpt.com/backend-api/codex/responses") throw new Error("Unexpected network request");
    if(new Headers(init.headers).get("authorization")!=="Bearer fixture-image-access")throw new Error("Wrong image auth");
    const body = JSON.parse(String(init.body)); let events;
    if (body.tools?.[0]?.type === "image_generation") {
      if(body.tools[0].model!=="gpt-image-2" || body.reasoning)throw new Error("Invalid image request");
      events=[{type:"response.output_item.done",item:{id:"ig_fixture",type:"image_generation_call",status:"completed",result:${JSON.stringify(base64)}}},
        {type:"response.completed",response:{status:"completed",output:[]}}];
    } else if (calls++ === 0) {
      if(!body.tools?.some(tool=>tool.name==="generate_image"))throw new Error("Image tool missing");
      events=[{type:"response.completed",response:{status:"completed",output:[{type:"function_call",id:"fc_fixture",call_id:"image-call",name:"generate_image",
        arguments:JSON.stringify({prompt:"A blue circle",output_path:"generated/circle.png",quality:"low"})}],usage:{input_tokens:10,output_tokens:5}}}];
    } else {
      if(!JSON.stringify(body.input).includes("data:image/png;base64,"))throw new Error("Generated image not returned to model");
      events=[{type:"response.output_text.delta",delta:"Image ready: generated/circle.png"},{type:"response.completed",response:{status:"completed",output:[{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"Image ready: generated/circle.png"}]}],usage:{input_tokens:20,output_tokens:5}}}];
    }
    return new Response(events.map(event=>"data: "+JSON.stringify(event)+"\\n\\n").join(""),{headers:{"Content-Type":"text/event-stream"}});
  };`
}
