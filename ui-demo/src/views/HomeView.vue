<template>
  <section style="width: 100%;height: 100vh;display: flex;flex-direction: column;overflow: hidden;">
    <div style="width: 100%;height: 50px;flex-shrink: 0;background-color: pink;">
      header
    </div>
    <div class="wrapper" ref="selectionViewportRef">
      <!-- useSource="mobile" -->
       <div class="main" ref="selectionRootRef">
        <CkcAnswer 
          ref="ckcAnswerRef"
          :messages="messages"  
          :historyMessages="historyMessages"
          render-custom-id="docs" 
          :custom-html-tags="['custom-data']"
          @click-recomendation="recomendationAsk"
          :markdown-component="MarkdownRender"
          @click-document="documentClick">
          <template #confirm="confirmProps">
            {{ confirmProps.confirmInfo }}
            <button @click="alterMessages(confirmProps)">确认信息</button>
          </template>
          <template #taskList="taskListProps">
            {{ taskListProps.taskListInfo }}
          </template>
          <template #actions="actionsProps">
            <button @click="alterMessages(actionsProps)">清空消息</button>
          </template>
        </CkcAnswer>
       </div>
       
            <Teleport v-if="selectionViewportRef" :to="selectionViewportRef">
             <div
               v-show="selectionVisible"
               ref="selectionToolbarRef"
               class="selection-ask-toolbar"
               :style="{ top: `${selectionTop}px`, left: `${selectionLeft}px` }"
               @mousedown.prevent
               @pointerdown.prevent
               @pointerup.prevent
             >
               <button type="button" class="selection-ask-toolbar__btn" @click="addSelectionToDialogue">
                 <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                   <path d="M7 7h5v5H9.5A2.5 2.5 0 0 1 7 9.5V7Zm8 0h5v5h-2.5A2.5 2.5 0 0 1 15 9.5V7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                 </svg>
                 添加至对话
               </button>
             </div>
            </Teleport>
      <!-- <button @click="stopChat()">清空消息</button> -->
    </div>
    <div
      ref="dialogueInputRef"
      style="width: 100%;height: 50px;flex-shrink: 0;background-color: red;"
      contenteditable="true"
      class="selection-ask-container"
    ></div>
  </section>
</template>

<script setup lang="ts">
  import { ref, onMounted, provide } from 'vue';
  import CkcAnswer from '../../../src/components/CkcAnswer/index.ts';
  import {CustomData, CustomDataArray } from '../../../src/components/CompForAnswer/index.ts';
  import mitt from 'mitt';
  import type { Message, Document } from '../../../src/components/types/message';
  import { message } from '../const/mock-data/message-file';
  import { setCustomComponents, MarkdownCodeBlockNode, CodeBlockNode } from 'markstream-vue';
  import { MarkdownRender } from 'markstream-vue';
  import { useSelectionAsk } from '../composables/useSelectionAsk';
  // import CustomComp from '../components/customComp.vue';

  const cardEmitter = mitt();
  provide('cardEmitter', cardEmitter);
  cardEmitter.on('schedule-card-click', (event) => {
    console.log('schedule-card-click', event)
  })
  cardEmitter.on('meeting-card-click', (event) => {
    console.log('meeting-card-click', event)
  })
  cardEmitter.on('file-card-click', (event) => {
    console.log('file-card-click', event)
  })
  cardEmitter.on('wiki-info-click', (event) => {
    console.log('wiki-info-click', event)
  })
  cardEmitter.on('wiki-link-click', (event) => {
    console.log('wiki-link-click', event)
  })
  cardEmitter.on('file-save', (event) => {
    console.log('file-save', event)
  })
  CustomData.useSource = 'mobile';
  CustomDataArray.useSource = 'mobile';
  setCustomComponents('docs', {
    'custom-data': CustomData,
    'custom-data-array': CustomDataArray,
    // 'markdown': MarkdownCodeBlockNode,
    'code_block': CodeBlockNode
  })
  const ckcAnswerRef = ref<InstanceType<typeof CkcAnswer> | null>(null)
  const selectionRootRef = ref<HTMLElement | null>(null)
  const selectionViewportRef = ref<HTMLElement | null>(null)
  const dialogueInputRef = ref<HTMLElement | null>(null)
  const {
    visible: selectionVisible,
    selectedText,
    top: selectionTop,
    left: selectionLeft,
    toolbarRef: selectionToolbarRef,
    hide: hideSelectionToolbar,
  } = useSelectionAsk(selectionRootRef, selectionViewportRef)
  const messages = ref<Message[]>([]);
  const historyMessages = ref<Message[]>([]);
  function alterMessages(actionsProps: any) {
    console.log('actionsProps', actionsProps)
  }
  function stopChat() {
    ckcAnswerRef.value?.stopChat();
  }
  function recomendationAsk(message: string) {
    console.log('recomendationAsk', message)
  }
  function documentClick(message: Document) {
    console.log('documentClick', message)
  }
  function insertTextIntoDialogue(text: string) {
    const el = dialogueInputRef.value
    if (!el) return
    el.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
    const inserted = document.execCommand('insertText', false, text)
    if (!inserted) {
      el.append(document.createTextNode(text))
    }
  }

  function addSelectionToDialogue() {
    const text = selectedText.value
    if (!text.trim()) return
    insertTextIntoDialogue(text)
    hideSelectionToolbar()
  }
  onMounted(() => {
    let index = 0;
    const addMessage = () => {
      if (index < message.length) {
        messages.value.push(message[index] as Message);
        index++;
        setTimeout(addMessage, 20); // 每200毫秒添加一条消息，模拟流式返回
      }
    };
    addMessage();
  });
  // onMounted(() => {
  //   // messages.value = message as Message[];
  //   historyMessages.value = message as Message[];
  // });
</script>

<style>
  .wrapper {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    justify-content: center;
    background-color: burlywood;
    overflow: auto;
  }
  .main {
    width: 800px;
  }
  .selection-ask-toolbar {
    position: absolute;
    z-index: 10000;
    pointer-events: auto;
    transform: translate(-50%, -100%);
    display: flex;
    align-items: center;
    padding: 6px 10px;
    background: #fff;
    border-radius: 10px;
    box-shadow: 0 6px 20px rgba(23, 32, 77, 0.16);
    user-select: none;
  }
  .selection-ask-toolbar__btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: transparent;
    padding: 4px 6px;
    color: #1f2430;
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
  }
  .selection-ask-toolbar__btn:hover {
    color: #4f7dff;
  }
</style>

