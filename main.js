// シャッフル
function shuffle(array){

  for(let i = array.length - 1; i > 0; i--){

    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] = [array[j], array[i]];
  }
}

// 席替え
function makeSeats(){

  // 座席配置
  const layout = document.getElementById("layoutInput").value
    .split(",")
    .map(v => Number(v.trim()))
    .filter(v => v > 0);

  // 空白位置
  const alignType =
    document.getElementById("alignType").value;

  // タイトル
  document.getElementById("displayTitle").textContent =
    document.getElementById("sheetTitle").value;

  // 名前
  const nameLines = document.getElementById("nameInput").value
    .split("\n")
    .map(v => v.trim())
    .filter(v => v !== "");

  // 読みがな
  const furiganaLines = document.getElementById("furiganaInput").value
    .split("\n")
    .map(v => v.trim());

  // 前席希望
  const frontPeople = document.getElementById("frontInput").value
    .split("\n")
    .map(v => v.trim())
    .filter(v => v !== "");

  // 生徒データ
  let students = [];

  for(let i = 0; i < nameLines.length; i++){

    students.push({
      number:i + 1,
      name:nameLines[i],
      furigana:furiganaLines[i] || ""
    });
  }

  // 最大人数
  const totalSeats = layout.reduce((a,b)=>a+b,0);

  if(students.length > totalSeats){

    alert(`人数が多すぎます！（最大 ${totalSeats} 人）`);

    return;
  }

  // 前席希望
  let frontList = students.filter(s =>
    frontPeople.includes(s.name)
  );

  // その他
  let others = students.filter(s =>
    !frontPeople.includes(s.name)
  );

  // シャッフル
  shuffle(frontList);
  shuffle(others);

  // ===== 座席データ =====

  let seatPositions = [];

  const maxRows = Math.max(...layout);

  // 上→下
  for(let row = 0; row < maxRows; row++){

    // 左→右
    for(let col = 0; col < layout.length; col++){

      const columnHeight = layout[col];

      let startRow = 0;

      if(alignType === "top"){

        startRow = 0;

      }else if(alignType === "center"){

        startRow = Math.floor(
          (maxRows - columnHeight) / 2
        );

      }else{

        startRow = maxRows - columnHeight;
      }

      if(
        row < startRow ||
        row >= startRow + columnHeight
      ){
        continue;
      }

      seatPositions.push({
        row,
        col
      });
    }
  }

  // 前から順（教卓側優先 → 左右ランダム）
  const frontOrderedSeats = [...seatPositions]
    .sort((a,b) => {

      // 前優先
      if(a.row !== b.row){

        return b.row - a.row;
      }

      // 同じ列ならランダム
      return Math.random() - 0.5;
    });

  // 空座席
  let seatMap = new Array(seatPositions.length).fill(null);

  // 前席希望者
  frontList.forEach((student,index)=>{

    const targetSeat = frontOrderedSeats[index];

    const seatIndex = seatPositions.findIndex(seat =>
      seat.row === targetSeat.row &&
      seat.col === targetSeat.col
    );

    seatMap[seatIndex] = student;
  });

  // 空席
  let emptyIndexes = [];

  seatMap.forEach((seat,index)=>{

    if(seat === null){

      emptyIndexes.push(index);
    }
  });

  // その他配置
  others.forEach((student,index)=>{

    seatMap[emptyIndexes[index]] = student;
  });

  // ===== 表示 =====

  const seatArea = document.getElementById("seatArea");

  seatArea.innerHTML = "";

  let index = 0;

  // 上から順
  for(let row = 0; row < maxRows; row++){

    const rowDiv = document.createElement("div");

    rowDiv.className = "row";

    // 左→右
    for(let col = 0; col < layout.length; col++){

      const columnHeight = layout[col];

      let startRow = 0;

      if(alignType === "top"){

        startRow = 0;

      }else if(alignType === "center"){

        startRow = Math.floor(
          (maxRows - columnHeight) / 2
        );

      }else{

        startRow = maxRows - columnHeight;
      }

      // 空白判定
      if(
        row < startRow ||
        row >= startRow + columnHeight
      ){

        const empty = document.createElement("div");

        empty.style.width = "150px";

        rowDiv.appendChild(empty);

        continue;
      }

      const seat = document.createElement("div");

      seat.className = "seat";

      // 前2行
      if(row >= maxRows - 2){

        seat.classList.add("frontSeat");
      }

      const student = seatMap[index];

      if(student){

        seat.innerHTML = `
          <div class="furigana">
            ${student.furigana}
          </div>

          <div class="nameRow">

            <div class="number">
              ${student.number}
            </div>

            <div class="name">
              ${student.name}
            </div>

          </div>
        `;
      }

      rowDiv.appendChild(seat);

      index++;
    }

    seatArea.appendChild(rowDiv);
  }

  // 教卓
  const teacher = document.createElement("div");

  teacher.className = "teacher";

  teacher.textContent = "教卓";

  seatArea.appendChild(teacher);

  window.currentSeatMap = seatMap;
  window.currentLayout = layout;
  window.currentMaxRows = maxRows;
}

// PDF保存
async function savePDF(){

  const { jsPDF } = window.jspdf;

  const target =
    document.getElementById("pdfTarget");

  const canvas = await html2canvas(target,{
    scale:2
  });

  const imgData =
    canvas.toDataURL("image/png");

  const size =
    document.getElementById("pdfSize").value;

  const pdf = new jsPDF({
    orientation:"landscape",
    unit:"mm",
    format:size
  });

  const pageWidth =
    pdf.internal.pageSize.getWidth();

  const pageHeight =
    pdf.internal.pageSize.getHeight();

  const imgWidth = canvas.width;
  const imgHeight = canvas.height;

  const ratio = Math.min(
    pageWidth / imgWidth,
    pageHeight / imgHeight
  );

  const width = imgWidth * ratio;
  const height = imgHeight * ratio;

  const x = (pageWidth - width) / 2;
  const y = (pageHeight - height) / 2;

  pdf.addImage(
    imgData,
    "PNG",
    x,
    y,
    width,
    height
  );

  const title =
    document.getElementById("sheetTitle").value.trim();

  pdf.save(
    (title || "seat-table") + ".pdf"
  );
}

// ===== Excel保存 =====

async function saveExcel(){

  const workbook = new ExcelJS.Workbook();

  const sheet =
    workbook.addWorksheet("席替え");

  // ===== 全体白線 =====

  for(let r = 1; r <= 200; r++){

    for(let c = 1; c <= 100; c++){

      const cell = sheet.getCell(r,c);

      cell.border = {
        top:{
          style:"thin",
          color:{argb:"FFFFFFFF"}
        },
        left:{
          style:"thin",
          color:{argb:"FFFFFFFF"}
        },
        bottom:{
          style:"thin",
          color:{argb:"FFFFFFFF"}
        },
        right:{
          style:"thin",
          color:{argb:"FFFFFFFF"}
        }
      };
    }
  }

  // ===== タイトル =====

  const title =
    document.getElementById("sheetTitle")
      .value.trim() || "席替え";

  const layout =
    document.getElementById("layoutInput")
      .value
      .split(",")
      .map(v => Number(v.trim()))
      .filter(v => v > 0);

  const maxRows =
    Math.max(...layout);

  sheet.mergeCells(
    1,
    1,
    1,
    layout.length * 3 - 1
  );

  const titleCell =
    sheet.getCell(1,1);

  titleCell.value = title;

  titleCell.font = {
    name:"Zen Kurenaido",
    size:19,
    underline:true
  };

  titleCell.alignment = {
    horizontal:"center",
    vertical:"middle"
  };

  sheet.getRow(1).height = 44;

  // ===== 列幅 =====

  for(let col = 0; col < layout.length; col++){

    // 出席番号列
    sheet.getColumn(col * 3 + 1)
      .width = 3.5;

    // 名前列
    sheet.getColumn(col * 3 + 2)
      .width = 12.7;

    // 空白列
    sheet.getColumn(col * 3 + 3)
      .width = 3.8;
  }

  // ===== 座席 =====

  const seats =
    window.currentSeatMap || [];

  const startRow = 3;

  let index = 0;

  for(let row = 0; row < maxRows; row++){

    for(let col = 0; col < layout.length; col++){

      const columnHeight =
        layout[col];

      const startSeatRow =
        Math.floor(
          (maxRows - columnHeight) / 2
        );

      // 空白
      if(
        row < startSeatRow ||
        row >= startSeatRow + columnHeight
      ){
        continue;
      }

      const student =
        seats[index];

      const r =
        startRow + row * 3;

      const c =
        col * 3 + 1;

      // ===== 読みがな =====

      sheet.mergeCells(
        r,
        c,
        r,
        c + 1
      );

      const furiganaCell =
        sheet.getCell(r,c);

      furiganaCell.value =
        student?.furigana || "";

      furiganaCell.font = {
        name:"Zen Kurenaido",
        size:9
      };

      furiganaCell.alignment = {
        horizontal:"center",
        vertical:"middle"
      };

      furiganaCell.border = {
        top:{
          style:"thin",
          color:{argb:"FF000000"}
        },
        left:{
          style:"thin",
          color:{argb:"FF000000"}
        },
        bottom:{
          style:"thin",
          color:{argb:"FF000000"}
        },
        right:{
          style:"thin",
          color:{argb:"FF000000"}
        }
      };

      // ===== 出席番号 =====

      const numberCell =
        sheet.getCell(r + 1, c);

      numberCell.value =
        student?.number || "";

      numberCell.font = {
        name:"Zen Kurenaido",
        size:11
      };

      numberCell.alignment = {
        horizontal:"center",
        vertical:"middle"
      };

      numberCell.border = {
        top:{
          style:"thin",
          color:{argb:"FF000000"}
        },
        left:{
          style:"thin",
          color:{argb:"FF000000"}
        },
        bottom:{
          style:"thin",
          color:{argb:"FF000000"}
        },
        right:{
          style:"thin",
          color:{argb:"FF000000"}
        }
      };

      // ===== 名前 =====

      const nameCell =
        sheet.getCell(r + 1, c + 1);

      nameCell.value =
        student?.name || "";

      nameCell.font = {
        name:"Zen Kurenaido",
        size:11
      };

      nameCell.alignment = {
        horizontal:"center",
        vertical:"middle"
      };

      nameCell.border = {
        top:{
          style:"thin",
          color:{argb:"FF000000"}
        },
        left:{
          style:"thin",
          color:{argb:"FF000000"}
        },
        bottom:{
          style:"thin",
          color:{argb:"FF000000"}
        },
        right:{
          style:"thin",
          color:{argb:"FF000000"}
        }
      };

      index++;
    }

    // ===== 行高さ =====

    const rr =
      startRow + row * 3;

    // 読みがな
    sheet.getRow(rr).height = 16.5;

    // 名前
    sheet.getRow(rr + 1).height = 30.8;

    // 空白
    sheet.getRow(rr + 2).height = 15.8;
  }

  // ===== 教卓 =====

  const teacherRow =
    startRow + maxRows * 3;

  sheet.getRow(teacherRow)
    .height = 44;

  const totalCols =
    layout.length * 3;

  const teacherWidth = 6;

  const teacherStart =
    Math.floor(
      (totalCols - teacherWidth) / 2
    ) + 1;

  const teacherEnd =
    teacherStart + teacherWidth - 1;

  sheet.mergeCells(
    teacherRow,
    teacherStart,
    teacherRow,
    teacherEnd
  );

  const teacherCell =
    sheet.getCell(
      teacherRow,
      teacherStart
    );

  teacherCell.value = "教卓";

  teacherCell.font = {
    name:"Zen Kurenaido",
    size:22
  };

  teacherCell.alignment = {
    horizontal:"center",
    vertical:"middle"
  };

  teacherCell.border = {
    top:{
      style:"thin",
      color:{argb:"FF000000"}
    },
    left:{
      style:"thin",
      color:{argb:"FF000000"}
    },
    bottom:{
      style:"thin",
      color:{argb:"FF000000"}
    },
    right:{
      style:"thin",
      color:{argb:"FF000000"}
    }
  };

  // ===== 不要列削除 =====

  const lastUsedCol =
    layout.length * 3 - 1;

  if(sheet.columnCount > lastUsedCol){

    sheet.spliceColumns(
      lastUsedCol + 1,
      sheet.columnCount - lastUsedCol
    );
  }

  // ===== 不要行削除 =====

  const lastUsedRow =
    teacherRow;

  if(sheet.rowCount > lastUsedRow){

    sheet.spliceRows(
      lastUsedRow + 1,
      sheet.rowCount - lastUsedRow
    );
  }

  // ===== 保存 =====

  const buffer =
    await workbook.xlsx.writeBuffer();

  saveAs(

    new Blob(
      [buffer],
      {
        type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      }
    ),

    `${title}.xlsx`
  );
}

// fetch中断用
let currentController = null;

// キャンセル判定
let isCanceled = false;

// キャンセル
function cancelGoogleSave(){

  isCanceled = true;

  if(currentController){

    currentController.abort();
  }

  document.getElementById(
    "loadingOverlay"
  ).style.display = "none";
}

// ===== Googleスプレッドシート保存 =====

async function saveGoogleSheet(){

  // キャンセル状態リセット
  isCanceled = false;

  // ローディング表示
  const loading =
    document.getElementById("loadingOverlay");

  loading.style.display = "flex";

  try{

    // 先に席替えされているか確認
    if(!window.currentSeatMap){

      loading.style.display = "none";

      alert("先に「席替えする」を押してください");

      return;
    }

    // GASのウェブアプリURL
    const url =
      "https://script.google.com/macros/s/AKfycbyyzicpdPC5_UFWY7KK3QlJeGf13piOd8IxkaCvKmaiJ_tPfkC-CQMs0j2LgBypbX3Z/exec";

    // 保存データ
    const dataToSend = {

      title:
        document.getElementById("sheetTitle").value || "席替え",

      layout:
        window.currentLayout,

      maxRows:
        window.currentMaxRows,

      seats:
        window.currentSeatMap
    };

    // AbortController
    currentController =
      new AbortController();

    // GASへ送信
    const res = await fetch(url,{

      method:"POST",

      headers:{
        "Content-Type":"text/plain"
      },

      body:JSON.stringify(dataToSend),

      signal:currentController.signal
    });

    // JSON取得
    const data = await res.json();

    console.log(data);

    // 成功
    if(data.success && data.url){

      window.open(data.url, "_blank");

    }else{

      alert(
        data.error ||
        "スプレッドシートURLを取得できませんでした"
      );
    }

  }catch(error){

    console.error(error);

    // キャンセル時は何もしない
    if(!isCanceled){

      alert(
        "Googleスプレッドシート保存に失敗しました。\n" +
        "GASの公開設定を確認してください。"
      );
    }

  }finally{

    // ローディング終了
    document.getElementById(
      "loadingOverlay"
    ).style.display = "none";

    currentController = null;
  }
}